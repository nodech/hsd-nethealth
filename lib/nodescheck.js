/*!
 * pool.js - managing the peer pool for health checks.
 * Copyright (c) 2024, Nodari Chkuaselidze (MIT License)
 */

'use strict';

const assert = require('bsert');
const EventEmitter = require('events');
const List = require('blst');
const {Network} = require('hsd');
const Heap = require('bheep');
const seeds = require('hsd/lib/net/seeds/main');
const Logger = require('blgr');

class NodesHealthPool extends EventEmitter {
  constructor(options) {
    super();

    this.options = new HealthPoolOptions(options);
    this.logger = new Logger();
    this.current = 0;
    this.peers = new PeerList();

    // Prio queue for node checks.
    //  0 - highest priority for seed nodes.
    //  1 > - lower priority for other nodes, they will
    //  degrade after consecutive failures.
    this.checkQueue = new Heap(comparePrioQueue);
    this.scores = new Map();

    this.checkDNSQueue = new List();

    this.dnsLoop = null;
  }

  /**
   * Start the pool.
   * @returns {Promise}
   */

  async open() {
  }

  /**
   * Stop the pool.
   * @returns {Promise}
   */

  async close() {
  }

  /**
   * Start node checks.
   */

  startNodeLoop() {
  }

  /**
   * Stop node checks.
   */

  stopNodeLoop() {
  }

}

class HealthPoolOptions {
  constructor(options) {
    this.network = Network.primary;

    this.logger = Logger.global;

    // DNS seed health checks
    this.dnsEnabled = true;
    // 10 minutes
    this.dnsCheckFrequency = 10 * 60 * 1000;
    this.dnsCheckInterval = 1000;
    this.dnsSeeds = Network.primary.seeds;

    // 5 minutes
    this.nodesEnabled = true;
    this.nodesCheckFrequency = 5 * 60 * 1000;
    // how frequently to check list of pending requests.
    this.nodesCheckInterval = 1000;
    // node connections only (no dns)
    this.nodesCheckParallel = 50;

    // Default for main is in fromOptions.
    this.nodes = [];
    this.nodesDiscoverNew = true;

    this.nodesCheckBrontide = true;
    this.nodesCheckPrune = true;
    this.nodesCheckCompact = true;
    this.nodesCheckSPV = true;

    if (options)
      this.fromOptions(options);
  }

  fromOptions(options) {
    assert(typeof options === 'object');

    if (options.logger != null) {
      assert(typeof options.logger === 'object');
      this.logger = options.logger;
    }

    if (options.network != null) {
      assert(typeof options.network === 'string');
      this.network = Network.get(options.network);
    }

    if (options.nodesEnabled != null) {
      assert(typeof options.nodesEnabled === 'boolean');
      this.nodesEnabled = options.nodesEnabled;
    }

    if (options.nodesCheckFrequency != null) {
      assert(typeof options.nodesCheckFrequency === 'number');
      assert(options.nodesCheckFrequency >= 0);
      this.nodesCheckFrequency = options.nodesCheckFrequency;
    }

    if (options.nodesCheckParallel != null) {
      assert(typeof options.nodesCheckParallel === 'number');
      this.nodesCheckParallel = options.nodesCheckParallel;
    }

    if (options.nodesCheckInterval != null) {
      assert(typeof options.nodesCheckInterval === 'number');
      assert(options.nodesCheckInterval >= 0);
      this.nodesCheckInterval = options.nodesCheckInterval;
    }

    if (options.nodesDiscoverNew != null) {
      assert(typeof options.nodesDiscoverNew === 'boolean');
      this.nodesDiscoverNew = options.nodesDiscoverNew;
    }

    if (options.nodes != null) {
      assert(Array.isArray(options.nodes));
      this.nodes = options.nodes;
    } else if (this.network.type === 'main') {
      this.nodes = seeds;
    }

    if (options.nodesCheckBrontide != null) {
      assert(typeof options.nodesCheckBrontide === 'boolean');
      this.nodesCheckBrontide = options.nodesCheckBrontide;
    }

    if (options.nodesCheckPrune != null) {
      assert(typeof options.nodesCheckPrune === 'boolean');
      this.nodesCheckPrune = options.nodesCheckPrune;
    }

    if (options.nodesCheckCompact != null) {
      assert(typeof options.nodesCheckCompact === 'boolean');
      this.nodesCheckCompact = options.nodesCheckCompact;
    }

    if (options.nodesCheckSPV != null) {
      assert(typeof options.nodesCheckSPV === 'boolean');
      this.nodesCheckSPV = options.nodesCheckSPV;
    }

    return this;
  }
}

class PeerList {
  /**
   * Create peer list.
   * @constructor
   * @param {Object} options
   */

  constructor() {
    this.map = new Map();
    this.ids = new Map();
    this.list = new List();
    this.load = null;
    this.inbound = 0;
    this.outbound = 0;
  }

  /**
   * Get the list head.
   * @returns {Peer}
   */

  head() {
    return this.list.head;
  }

  /**
   * Get the list tail.
   * @returns {Peer}
   */

  tail() {
    return this.list.tail;
  }

  /**
   * Get list size.
   * @returns {Number}
   */

  size() {
    return this.list.size;
  }

  /**
   * Add peer to list.
   * @param {Peer} peer
   */

  add(peer) {
    assert(this.list.push(peer));

    assert(!this.map.has(peer.hostname()));
    this.map.set(peer.hostname(), peer);

    assert(!this.ids.has(peer.id));
    this.ids.set(peer.id, peer);

    if (peer.outbound)
      this.outbound += 1;
    else
      this.inbound += 1;
  }

  /**
   * Remove peer from list.
   * @param {Peer} peer
   */

  remove(peer) {
    assert(this.list.remove(peer));

    assert(this.ids.has(peer.id));
    this.ids.delete(peer.id);

    assert(this.map.has(peer.hostname()));
    this.map.delete(peer.hostname());

    if (peer === this.load) {
      assert(peer.loader);
      peer.loader = false;
      this.load = null;
    }

    if (peer.outbound)
      this.outbound -= 1;
    else
      this.inbound -= 1;
  }

  /**
   * Get peer by hostname.
   * @param {String} hostname
   * @returns {Peer}
   */

  get(hostname) {
    return this.map.get(hostname);
  }

  /**
   * Test whether a peer exists.
   * @param {String} hostname
   * @returns {Boolean}
   */

  has(hostname) {
    return this.map.has(hostname);
  }

  /**
   * Get peer by ID.
   * @param {Number} id
   * @returns {Peer}
   */

  find(id) {
    return this.ids.get(id);
  }

  /**
   * Destroy peer list (kills peers).
   */

  destroy() {
    let next;

    for (let peer = this.list.head; peer; peer = next) {
      next = peer.next;
      peer.destroy();
    }
  }
}

class PeerItem {
  constructor(hostname) {
    this.priority = 0;
    this.peer = hostname;
  }
}

function comparePrioQueue(a, b) {
  return a.priority - b.priority;
}

module.exports = NodesHealthPool;
