var
	PeerState = require('./peer_state').PeerState,
	Scuttle = require('./scuttle').Scuttle,
	EventEmitter = require('eventemitter2').EventEmitter2,
	net = require('net'),
	util = require('util'),
	child_process = require('child_process'),
	dns = require('dns'),
	debug = require('debug')('telepathine'),
	dgram = require('dgram'),
	_ = require('lodash'),
	ipcompress = require('./ip');

//Network Configuration - should be true for all peers
var defaultUdp = true;
var defaultGossipIntervalMS = 2500;
var defaultHeartbeatIntervalMS = 2500;

var udpMaxMessageSize = 575; //1400 MTU limit
var eventDefaultTTL = 2500 * 8; //how long events remain active for


/*
	Default Options:
		options = {
			
			// For IPv4 use [a.b.c.d]:port, ex: 192.168.0.100:1234
			// For IPv6 use the format [ad:dre::ss]:port, ex: [::1]:9000
			address: '127.0.0.1', // localhost
			
			// Whether to emit value change events on heartbeats
			emitValueOnHeartBeat: false,
			
			// Manual Network address translation
			addressMap: {
				//key: value //key = address mapped from, value = address mapped to
			},
			
			// Network ID, used to encrypt messages, secured from non-network message.  undefined=public, no encryption
			network: "Preshared_Network_Key",
			
			udp: true,					//whether to run UDP server (recommended)
			
			gossipIntervalMS: 2500, 	//how often (ms) to send gossip updates

			heartbeatIntervalMS: 2500 	//how often (ms) to send heartbeat updates
		};
		
*/
var Telepathine = exports.Telepathine = function (port, seeds, options) {
	var self = this;

	EventEmitter.call(this, { wildcard: true, delimiter: ':' });

	if (!options) options = { };
	
	if (typeof port !== 'number' || port === 0)
		throw new Error('must specify a port');

	this.public = true; //true = allow WAN connections, false = only LAN

	
	this.peers = {};
	this.address = options.address || '127.0.0.1';
	this.addressMap = options.addressMap || { };

	this.network = options.network;
	
	if (this.network) {
		var crypto = require('crypto');
		var alg = 'aes192';
		var key = crypto.createHash('sha256').update(this.network).digest();
		
		this.networkEncipher = function(input) {
			var c = crypto.createCipher(alg, key);
			var a1 = c.update(input, 'utf8');
			var a2 = c.final();
			var b = Buffer.concat([a1, a2]);
			return b;
		}
		this.networkDecipher = function(input) {
			var c = crypto.createDecipher(alg, key);
			var a1 = c.update(input, 'binary', 'utf8');
			var a2 = c.final('utf8');
			return a1 + a2;
		}
		
	}
	
	this.port = port;
	this.seeds = seeds || [];
	this.my_state = new PeerState(this.port, this.address);
	this.peer_name = net.isIPv6(this.address) ? ['[' + this.address + ']', this.port.toString()].join(':') : [this.address, this.port.toString()].join(':');

	this.listenToExpiredKeys(this.my_state)

	this.localEventNumber = 0; //should this be Date.now() and increment by milliseconds? this way if a peer gets restarted, it should have a unique set of events in the system, assuming they live longer than the reconnect interval
	this.localEventPrefix = ipcompress.IPStringToB64(this.address+':'+this.port);
	
	this.beatHeart = true;
	this.emitValueOnHeartBeat = options.emitValueOnHeartBeat || false;
	
	this.gossipIntervalMS = options.gossipIntervalMS || defaultGossipIntervalMS;
	this.heartbeatIntervalMS = options.heartbeatIntervalMS || defaultHeartbeatIntervalMS;
	this.udp = options.udp || defaultUdp;
		
	this.scuttle = new Scuttle(this.peers);
};

util.inherits(Telepathine, EventEmitter);


var fs = require('./fs');
exports.FileInput = fs.FileInput;
exports.FileOutput = fs.FileOutput;
exports.FileSync = fs.FileSync;



Telepathine.prototype.start = function (callback) {
	var self = this;

	//TCP server
	this.server = net.createServer(function (socket) {
		
		var msgSize = 0;
		var msgPosition = 0;
		var message = null;
		
		socket.on('data', function (m) {
			try
			{
				if (message == null) {
					//get the message size from first 4 bytes of m
					msgSize = m.readUInt32BE(0) ; 
					message = new Buffer(msgSize); //try catch because: was error here, buffer larger than memory, probably because of bad input
					m.copy(message, 0, 4); //skip the size bytes
					msgPosition += m.length - 4;
				}
				else {
					m.copy(message, msgPosition, 0, msgSize - msgPosition);
					msgPosition += m.length;
					
					//TODO what if a new message begins in this buffer?
				}
				
				if (msgPosition == msgSize) {
					self.handleMessage(socket, message);
					message = null;
					msgSize = msgPosition = 0;
				}
			}
			catch(e)
			{
				if (debug.enabled) debug('%s => %s error: %s', socket.remoteAddress + socket.remotePort, e);
			}
		});

		socket.on('error', function (e) {
			if (debug.enabled) debug('%s => %s error: %s', socket.remoteAddress + socket.remotePort, e);
		})
	});

	function start() {
		if (debug.enabled) debug('%s TCP start', self.peer_name);

		if (callback)
			callback(self)

		self.running = true;
		self.emit('start', self)
	}


	// Bind to ip/port
	if (this.address) {
		this.my_state.address = this.address;
		this.my_state.port = this.port;
		this.peers[this.peer_name] = this.my_state;

		this.server.listen(this.port, (self.public ? null : this.address), start);
	} else {
		// this is an ugly hack to get the hostname of the local machine
		// we don't listen on any ip because it's important that we listen
		// on the same ip that the server identifies itself as
		child_process.exec('hostname', function (error, stdout, stderr) {
			var l = stdout.length;
			var hostname = stdout.slice(0, l - 1);
			dns.lookup(hostname, 4, function (err, address, family) {
				self.address = address;
				self.my_state.address = self.address;
				self.my_state.port = self.port;
				self.peers[self.peer_name] = self.my_state;


				self.server.listen(self.port, (self.public ? null : address), start);
			});


		});
	}

	if (this.udp) {
		var udpServer = this.udpServer = dgram.createSocket("udp4");


		// Listen for message events on the socket.
		udpServer.on("message", function (message, r /* request info */ ) {
			self.handleMessage(udpServer, message, {
				address: r.address,
				port: r.port
			});
		});

		udpServer.on("error", function (error) {
			if (debug.enabled) debug('%s UDP error', self.peer_name, error);
		});

		// When the socket is configured and ready to receive data
		udpServer.on("listening", function () {
			//var address = socket.address();
			//console.log( "socket listening " + address.address + ":" + address.port );
			if (debug.enabled) debug('%s UDP start', self.peer_name);
		});

		udpServer.bind(this.port);
	}


	for (var i = 0; i < this.seeds.length; i++) {
		if (this.seeds[i] === this.peer_name)
			throw new Error('cannot specify self as seed')
	}

	// another ugly hack :(
	var seeds = {};

	for (var i = 0; i < this.seeds.length; i++)
		seeds[this.seeds[i]] = undefined;

	this.handleNewPeers(seeds);

	if (this.beatHeart)
		this.heartBeatTimer = setInterval(function () {
			self.my_state.beatHeart()
		}, this.heartbeatIntervalMS);
	
	this.gossipNow();
	
	this.on('set', function (peer, k, v) {
		if (k.indexOf('say:')===0) {
			//TODO avoid reprocessing events
			k = k.split(':');
			var whichEvent = k[1];
						
			self.emit('say:' + whichEvent, v, peer);
		}
	});
	
	return this;
}


Telepathine.prototype.addPeer = function (toipandport) {
	 if (toipandport === this.peer_name)
	 {
	 	if (debug.enabled) debug('cannot specify self as peer');
	 	return false;
	 }
	 if(toipandport in this.peers)
	 {
	 	if (debug.enabled) debug('peer already exists')
	 	return false
	 }
	 var x={};x[toipandport]=undefined;
	 this.handleNewPeers(x);
	 return true;
};


/* force immediate broadcast and reset gossip timer
		todo: optional parameter to skip immediate gossip if next gossip is below a duration threshold
*/
Telepathine.prototype.gossipNow = function() {	
	if (this.gossipTimer)
		clearInterval(this.gossipTimer);

	var self = this;
	this.gossip();
	
	this.gossipTimer = setInterval(function () {
		self.gossip()
	}, this.gossipIntervalMS);	
};

Telepathine.prototype.stop = function () {
	this.server.close();
	if (this.udpServer)
		this.udpServer.close();
	
	clearInterval(this.heartBeatTimer);
	clearInterval(this.gossipTimer);
	this.running = false;
	
	var self = this;
	this.emit('stop', self)
};


/*	distribute an event by setting a local key with the 'say:' prefix.
		ttl: relative time in milliseconds that the event will be active in the network
		buffered: true=batch the event with the next update, false=send immediately (default)		
*/
Telepathine.prototype.say = function (event, data, ttl /* in milliseconds*/, buffered) {
	//TODO add anonymous parameter?
	if (!ttl)
		ttl = eventDefaultTTL;
	var eventID = this.localEventPrefix + '_' + this.localEventNumber++;
	var eventname = 'say:' + event + ':' + eventID;
	this.set(eventname, data, Date.now() + ttl);	
	
	if (!buffered)
		this.gossipNow();
};

Telepathine.prototype.hear = function (event, callback) {
	this.on('say:' + event, function(value, peer) {
		this.event = this.event.split(':')[1];
		callback.apply(this, [value, peer]);
	});	
};

Telepathine.prototype.hearOnce = function (event, callback) {
	this.once('say:' + event, function(value, peer) {
		this.event = this.event.split(':')[1];
		callback.apply(this, [value, peer]);
	});			
};

Telepathine.prototype.know = function (key, callback) {
	this.on('set:' + key, function(peer, key, value, ttl) {
		this.event = this.event.split(':')[1];
		if (callback)
			callback.apply(this, [peer, key, value, ttl]);
	});
};

Telepathine.prototype.believe = function (key, callback) {
	var that = this;
	this.on('set:' + key, function(peer, key, value, ttl) {
		if (peer!=that.peer_name) {
			if (!_.isEqual(that.get(key), value)) {
				that.set(key, value, ttl);
				if (callback) {
					callback.apply(this, [peer, key, value, ttl]);
				}
			}

		}		
	});	
};


Telepathine.prototype.after = function (delayMS, f) {
	var self = this;
	function a() { setTimeout(f.bind(self), delayMS);	}	
	if (this.running)	a();	
	else				this.once('start', a);
	return this;
};
Telepathine.prototype.every = function (intervalMS, f) {
	var self = this;
	function a() { setInterval(f.bind(self), delayMS);	}
	if (this.running)	a();	
	else				this.once('start', a);
};


// The method of choosing which peer(s) to gossip to is borrowed from Cassandra.
// They seemed to have worked out all of the edge cases
// http://wiki.apache.org/cassandra/ArchitectureGossip
Telepathine.prototype.gossip = function () {
	//this.emit('gossip start');

	var now = Date.now();

	for (var p in this.peers)
		this.peers[p].expireLocalKeys(now);

	var livePeers = this.livePeers();

	// Find a live peer to gossip to
	var livePeer;

	if (livePeers.length > 0) {
		livePeer = this.chooseRandom(livePeers);
		this.gossipToPeer(livePeer);
	}

	var deadPeers = this.deadPeers();

	// Possilby gossip to a dead peer
	var prob = deadPeers.length / (livePeers.length + 1)
	if (Math.random() < prob) {
		var deadPeer = this.chooseRandom(deadPeers);
		this.gossipToPeer(deadPeer);
	}

	//TODO this following comment is from the original fork, i dont understand
	//why it says "gossip to seed" but chooses a peer from all the peers
	// Gossip to seed under certain conditions
	if (livePeer && !this.seeds[livePeer] && livePeers.length < this.seeds.length) {
		if (Math.random() < (this.seeds / this.peers.length)) {
			var p = this.chooseRandom(this.allPeers())
			this.gossipToPeer(p);
		}
	}

	// Check health of peers
	for (var i in this.peers) {
		var peer = this.peers[i];
		if (peer !== this.my_state) {
			peer.isSuspect();
		}
	}
};

Telepathine.prototype.chooseRandom = function (peers) {
	// Choose random peer to gossip to
	var i = Math.floor(Math.random() * 1000000) % peers.length;
	return this.peers[peers[i]];
};

Telepathine.prototype.respondTCP = function (m, socket) {	
		
	var b;
	if (!Buffer.isBuffer(m)) {
		var mjson = JSON.stringify(m);
		if (this.networkEncipher)
			b = this.networkEncipher(new Buffer(mjson, 'utf8'));
		else
			b = new Buffer(mjson, "utf8");
	}
	else {
		b = m;
	}
	
	var msgSize = new Buffer(4);        
    msgSize.writeUInt32BE(b.length, 0); 	
	socket.write(msgSize);
	
	socket.write(b);
};

//attempt to send a UDP packet, but if the message is too large, use TCP
Telepathine.prototype.sendMessage = function (m, address, port) {
	var self = this;

	
	var	mjson = JSON.stringify(m);
	//console.log('send ', mjson);
	
	//TODO unify encipher with the TCP method
	var b;
	if (this.networkEncipher)
		b = this.networkEncipher(new Buffer(mjson, 'utf8'));	
	else
		b = new Buffer(mjson, "utf8");	

	if ((this.udp) && (b.length < udpMaxMessageSize))  {
		this.udpServer.send(
			b,
			0, // Buffer offset
			b.length,
			port,
			address,
			function (error, byteLength) {
				if (debug.enabled) debug('gossip:udp %s => %s, type %s, %s bytes', self.peer_name, (address + ':' + port), m.t, b.length)
			}
		);
		return;
	}

	var gosipeeSocket = new net.createConnection(port, address);

	/*gosipeeSocket.on('data', function (msg) {
		if (debug.enabled) debug('gossip:tcp:data %s => %s, type %s, %s bytes', (address + ':' + port), self.peer_name, (msg.t + ''), JSON.stringify(msg).length)
		self.handleMessage(gosipeeSocket, msg);
	});*/

	// when we are connected, send a request message
	gosipeeSocket.on('connect', function () {
		if (debug.enabled) debug('gossip:tcp:connect %s => %s, type %s, (%s bytes sent)', self.peer_name, address+':'+port, m.t, b.length)
		self.respondTCP(b, gosipeeSocket);
	});

	gosipeeSocket.on('error', function (exception) {
		if (debug.enabled) debug('gossip:tcp:error %s => %s : %s', self.peer_name, address+':'+port, exception);
	});

	gosipeeSocket.on('close', function () {
		if (debug.enabled) debug('gossip:tcp:close %s => %s', self.peer_name,  address+':'+port)
	});

}

Telepathine.prototype.resolveAddress = function(a) {
	var m = this.addressMap[a];
	if (m) return m;
	return a;
}

//TODO use an 'initialMessage' parameter (defaulting to self.requestMessage())' allowing TCP connect at any point in the protocol
Telepathine.prototype.gossipToPeer = function (peer) {
	var resolvedPeerAddress = this.resolveAddress(peer.address);
	
	if ( (this.port == peer.port) && ( (this.address == peer.address) || (resolvedPeerAddress == this.address)) ) {
		//console.error('gossiping to self');
		return;
	}
	if (debug.enabled) debug('gossip %s %s => %s %s', this.address, this.port, resolvedPeerAddress, peer.port)
				
	this.sendMessage(this.requestMessage(), peer.address, peer.port);		

}

Telepathine.REQUEST = 0;
Telepathine.FIRST_RESPONSE = 1;
Telepathine.SECOND_RESPONSE = 2;

Telepathine.prototype.handleMessage = function (socket, msg, fromPeer) {

	var self = this;
	
	if (self.networkDecipher) {		
		msg = (socket == this.udpServer) ? msg : new Buffer(msg, 'binary');
		try {
			msg = self.networkDecipher(msg);
		}
		catch (e) {
			if (debug.enabled) {
				if (socket == this.udpServer)
					debug('%s => %s bad UDP message', fromPeer.address+':'+fromPeer.port, self.peer_name);
				else
					debug('%s => %s bad TCP message', socket.remoteAddress + socket.remotePort, self.peer_name);
			}
			
			return;
		}
	}
	
	try {
		msg = JSON.parse(msg.toString('utf8'));
	}
	catch (e) {
		if (debug.enabled) {
			debug("invalid packet (" + msg.length + ' bytes)');			
		}
	}
	
	switch (msg.t) {
		case Telepathine.REQUEST:
			var msg = this.firstResponseMessage(msg.d);
			if (socket == this.udpServer) {
				this.sendMessage(msg, fromPeer.address, fromPeer.port);
			} else {
				this.respondTCP(msg, socket);
			}
			break;

		case Telepathine.FIRST_RESPONSE:
			if (msg.u)
				this.scuttle.updateKnownState(msg.u);
			var msg = this.secondResponseMessage(msg.r);

			if (socket == this.udpServer) {
				this.sendMessage(msg, fromPeer.address, fromPeer.port);
			} else {
				this.respondTCP(msg, socket);
				socket.end();
			}
			break;

		case Telepathine.SECOND_RESPONSE:
			this.scuttle.updateKnownState(msg.u);
			if (socket == this.udpServer) {
				//..
			} else {
				socket.end();
			}
			break;
		default:
			// something went bad
			break;
	}
}

// MESSSAGES
Telepathine.prototype.handleNewPeers = function (newPeers) {
	var self = this;


	for (var p in newPeers) {
		var peer_info;
		// TODO can this be done without regex?
		var m = p.match(/\[(.+)\]:([0-9]+)/);
		var address;
		var port;

		if (m) {
			address = m[1];
			port = m[2];
		} else {
			m = p.split(':');
			address = m[0];
			port = m[1];
		}


		var resolvedAddress = this.resolveAddress(address || '127.0.0.1');
		var resolvedName = resolvedAddress + ':' + port;
		if (this.peer_name == resolvedName) {
			//trying to add self, skip
			continue;
		}

		var tp = new PeerState(parseInt(port), resolvedAddress);

		tp.name = resolvedName;

		tp.metadata = newPeers[p]

		this.peers[tp.name] = tp;


		this.emit('peer:new', tp);

		this.listenToPeer(tp);
	}
}

Telepathine.prototype.listenToPeer = function (peer) {
	var self = this;

	if (peer.name === this.peer_name) {
		//throw new Error('cannot listen to itself')
		return;
	}

	var peerName = peer.name;

	this.listenToExpiredKeys(peer)

	peer.on('update', function (k, v, ttl) {

		// heartbeats are disabled by default but it can be changed so this takes care of that
		if ((k !== PeerState.heartbeat) || (self.emitValueOnHeartBeat)) {
			self.emit('set', peerName, k, v, ttl);
			self.emit('set:' + k, peerName, k, v, ttl);
		}
	});

	peer.on('peer_alive', function () {
		self.emit('peer:start', peerName);
	});

	peer.on('peer_failed', function () {
		self.emit('peer:stop', peerName);
	});
}

Telepathine.prototype.listenToExpiredKeys = function (peer) {

	var self = this;
	peer.on('expire', function (k, v, ttl) {
		self.emit('key:expire', self.my_state.name, k, v, ttl);
	});
}

Telepathine.prototype.requestMessage = function () {
	var m = {
		t: Telepathine.REQUEST, //type	
		d: this.scuttle.digest() //digest
	};
	return m;
};

Telepathine.prototype.firstResponseMessage = function (peer_digest) {
	var sc = this.scuttle.scuttle(peer_digest)

	this.handleNewPeers(sc.new_peers)

	var m = {
		t: Telepathine.FIRST_RESPONSE,	//type
	};
	
	//request_digest
	if (_.keys(sc.requests) > 0)
		m.r = sc.requests;

	//updates
	if (sc.deltas.length > 0)
		m.u = sc.deltas;

	return m;
};

Telepathine.prototype.secondResponseMessage = function (requests) {
	
	var m = {
		t: Telepathine.SECOND_RESPONSE
	};
	
	//updates
	var u = this.scuttle.fetchDeltas(requests)
	if (u.length > 0)
		m.u = u;
	
	return m;
};

Telepathine.prototype.set = function (k, v, expiresAt) {
	this.my_state.updateLocal(k, v, expiresAt);
}

Telepathine.prototype.get = function (k) {
	return this.my_state.getValue(k);
};

Telepathine.prototype.getRemoteKeys = function (peer) {
	return this.peers[peer].getKeys();
}

Telepathine.prototype.getRemote = function (peer, k) {
	return this.peers[peer].getValue(k);
}

Telepathine.prototype.allPeers = function () {
	var keys = [];
	for (var k in this.peers) {
		var peer = this.peers[k];
		if (peer !== this.my_state)
			keys.push(k)
	}
	return keys;
}

Telepathine.prototype.livePeers = function () {
	var keys = [];

	for (var k in this.peers) {
		var peer = this.peers[k];
		if (peer !== this.my_state && peer.alive) {
			keys.push(k)
		}
	}

	return keys;
}

Telepathine.prototype.deadPeers = function () {
	var keys = [];

	for (var k in this.peers) {
		var peer = this.peers[k];
		if (peer !== this.my_state && !peer.alive) {
			keys.push(k)
		}
	}

	return keys;
}
