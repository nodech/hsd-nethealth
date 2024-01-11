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
const Logger = require('blgr');
const seeds = require('hsd/lib/net/seeds/main');
const NetAddress = require('hsd/lib/net/netaddress');
const Peer = require('hsd/lib/net/peer');
const pkg = require('../package.json');
const InvItem = require('hsd/lib/primitives/invitem');
const packets = require('hsd/lib/net/packets');
const packetTypes = packets.types;
const invTypes = InvItem.types;

const BLOCK_100K = Buffer.from(
  '000000000000000136d7d3efa688072f40d9fdd71bd47bb961694c0f38950246', 'hex');

const ROOT_100K = Buffer.from(
  '11bc95fa048c55a4af9bd8d4a50c8e4564b03618f8729bfe582713ba3246fba6', 'hex');
// Zero key, proof of non-existence.
const KEY = Buffer.alloc(32, 0x00);
const COLLISION_KEY = Buffer.from(
  '00000007635ec9d18d935cd979ed47535486dd858e7e46b4e1b9d6c0deda02e3', 'hex');

class NodesHealthChecker extends EventEmitter {
  constructor(options) {
    super();

    this.options = new NodesHealthCheckerOptions(options);
    this.logger = this.options.logger.context('nodes') || Logger.global;
    this.current = 0;
    this.peers = new PeerList();
    this.agent = this.options.agent;

    // Prio queue for node checks.
    //  0 - highest priority for seed nodes.
    //  1 > - lower priority for other nodes, they will
    //  degrade after consecutive failures.
    this.queue = new Heap(comparePrioQueue);
    this.priorities = new Map();

    this.loop = null;
  }

  /**
   * Start the pool.
   * @returns {Promise}
   */

  async open() {
    if (!this.options.nodesEnabled)
      return;

    for (const node of this.options.nodes)
      this.scheduleCheck(node, 0, 0);

    this.startLoop();
  }

  /**
   * Stop the pool.
   * @returns {Promise}
   */

  async close() {
    this.stopLoop();
  }

  /**
   * Start node checks.
   */

  startLoop() {
    this.loop = setInterval(() => {
      if (this.queue.size() === 0)
        return;

      const maxParallel = this.options.nodesCheckParallel;
      while (this.queue.size() !== 0 && this.current < maxParallel) {
        const item = this.queue.shift();
        this.current += 1;
        this.checkNode(item.hostname);
      }
    }, this.options.nodesCheckInterval);
  }

  /**
   * Stop node checks.
   */

  stopLoop() {
    if (this.loop)
      clearInterval(this.loop);

    // reset queue.
    this.queue.items.length = 0;
    this.loop = null;
  }

  /**
   * Schedule node check.
   * @param {String} hostname
   * @param {Number} priority
   * @param {Number} [time] - time to check in ms.
   */

  scheduleCheck(hostname, priority, time = this.options.nodesCheckFrequency) {
    assert(typeof hostname === 'string');
    assert(typeof priority === 'number');
    assert(typeof time === 'number');

    this.logger.spam('Scheduling node check for %s(%d).', hostname, priority);

    this.priorities.set(hostname, priority);

    setTimeout(() => {
      this.logger.spam('Adding node check %s(%d)', hostname, priority);
      this.queue.insert(new PeerItem(hostname, priority));
    }, time);
  }

  /**
   * Check Node health.
   * @param {String} hostname
   * @returns {Promise}
   */

  checkNode(hostname) {
    const time = Date.now();
    const addr = NetAddress.fromHostname(hostname, this.options.network);

    this.logger.spam('Checking node "%s"(%d). Active: %d',
      hostname, this.priorities.get(hostname), this.current);

    let info = {
      time,
      hostname: addr.hostname,
      host: addr.host,
      port: addr.port,
      key: addr.key,
      error: null,
      result: null,
      frequency: this.options.nodesCheckFrequency,
      interval: this.options.nodesCheckInterval
    };

    this.checkNodeDetails(addr)
      .then((result) => {
        info.result = result;
        this.emit('node-success', info)
      }).catch((err) => {
        info.error = err;
        this.emit('node-fail', info);
      }).finally(() => {
        this.current -= 1;
      });
  }

  /**
   * Add node to the pool.
   * TODO: add peer error handling and timeout handler.
   * @param {NetAddress} addr
   * @returns {Promise<Object>} - result.
   */

  async checkNodeDetails(addr) {
    const options = {
      services: 0,
      agent: this.options.agent,
      noRelay: true
    };

    const peer = Peer.fromOutbound(options, addr);
    await peer.open();

    const info = {
      version: peer.version,
      services: peer.services,
      height: peer.height,
      agent: peer.agent,
      noRelay: peer.noRelay
    };

    const chainInfo = {
      pruned: false,
      treeCompacted: false
    };

    try {
      chainInfo.pruned = await this.checkPrune(peer);
      // We do this last because it will hangup the socket if the node
      // has compacted tree.
      chainInfo.treeCompacted = await this.checkCompact(peer);

      return {
        peer: info,
        chain: chainInfo
      };
    } finally {
      peer.destroy();
    }
  }

  /**
   * Check if node is pruned.
   * @param {Peer} peer
   * @returns {Promise<Boolean>}
   */

  async checkPrune(peer) {
    let timeout;

    const cleanup = () => {
      peer.onPacket = null;
      clearTimeout(timeout);
    };

    return new Promise((resolve, reject) => {
      setTimeout(() => {
        reject(new Error('Timeout'));
        cleanup();
      }, this.options.nodesCheckTimeout);;

      const onPacket = (packet) => {
        switch (packet.type) {
          case packetTypes.BLOCK: {
            const block = packet.block.toBlock();

            if (block.hash().equals(BLOCK_100K)) {
              resolve(false);
              cleanup();
            }
            break;
          }
          case packetTypes.NOTFOUND: {
            const items = packet.items;

            if (items.length !== 1)
              break;

            const item = items[0];

            if (item.type !== invTypes.BLOCK)
              break;

            if (item.hash.equals(BLOCK_100K)) {
              resolve(true);
              cleanup();
            }
          }
        }
      };

      peer.onPacket = onPacket;
      peer.getBlock([BLOCK_100K]);
    });
  }

  /**
   * Check if node has compacted tree.
   * @param {Peer} peer
   * @returns {Promise}
   */

  async checkCompact(peer) {
    let timeout, onError;

    const cleanup = () => {
      peer.onPacket = null;
      peer.removeListener('error', onError);
      clearTimeout(timeout);
    };

    return new Promise((resolve, reject) => {
      setTimeout(() => {
        reject(new Error('Timeout'));
        cleanup();
      }, this.options.nodesCheckTimeout);

      const onPacket = (packet) => {
        switch (packet.type) {
          case packetTypes.PROOF: {
            const proof = packet.proof;

            if (!proof.key.equals(COLLISION_KEY))
              break;

            // TYPE_COLLISION
            if (proof.type !== 2)
              break;

            if (proof.depth !== 24)
              break;

            resolve(false);
            cleanup();
          }
        }
      };

      onError = (err) => {
        if (err.message.match(/^Socket hangup..*$/)) {
          resolve(true);
          cleanup();
        }
      };

      peer.onPacket = onPacket;
      peer.on('error', onError);
      const getProofPacket = new packets.GetProofPacket(ROOT_100K, KEY);
      peer.send(getProofPacket);
    });
  }
}

class NodesHealthCheckerOptions {
  constructor(options) {
    this.network = Network.primary;

    this.logger = Logger.global;

    this.agent = `/${pkg.name}:${pkg.version}/`;

    // 5 minutes
    this.nodesEnabled = true;
    this.nodesCheckFrequency = 5 * 60 * 1000;
    // how frequently to check list of pending requests.
    this.nodesCheckInterval = 1000;
    // timeout to wait for node to respond.
    this.nodesCheckTimeout = 10 * 1000;

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

    if (options.agent != null) {
      assert(typeof options.agent === 'string');
      assert(!options.agent.includes('/'), 'User agent must not include "/"');
      this.agent += `${options.agent}/`;
      assert(this.agent.length <= 255, 'User agent exceeds 255 bytes.');
    }

    if (options.nodesEnabled != null) {
      assert(typeof options.nodesEnabled === 'boolean');
      this.nodesEnabled = options.nodesEnabled;
    }

    if (options.nodesCheckParallel != null) {
      assert(typeof options.nodesCheckParallel === 'number');
      this.nodesCheckParallel = options.nodesCheckParallel;
    }

    if (options.nodesCheckFrequency != null) {
      assert(typeof options.nodesCheckFrequency === 'number');
      assert(options.nodesCheckFrequency >= 0);
      this.nodesCheckFrequency = options.nodesCheckFrequency;
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
  constructor(hostname, priority) {
    this.hostname = hostname;
    this.priority = priority;
  }
}

function comparePrioQueue(a, b) {
  return a.priority - b.priority;
}

module.exports = NodesHealthChecker;
