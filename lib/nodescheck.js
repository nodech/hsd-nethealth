/*!
 * pool.js - managing the peer pool for health checks.
 * Copyright (c) 2024, Nodari Chkuaselidze (MIT License)
 */

'use strict';

const assert = require('bsert');
const EventEmitter = require('events');
const {Network} = require('hsd');
const Heap = require('bheep');
const Logger = require('blgr');
const secp256k1 = require('bcrypto/lib/secp256k1');
const seeds = require('hsd/lib/net/seeds/main');
const NetAddress = require('hsd/lib/net/netaddress');
const Peer = require('hsd/lib/net/peer');
const pkg = require('../package.json');
const InvItem = require('hsd/lib/primitives/invitem');
const packets = require('hsd/lib/net/packets');
const packetTypes = packets.types;
const invTypes = InvItem.types;

// Prune block check
const BLOCK_100K = Buffer.from(
  '000000000000000136d7d3efa688072f40d9fdd71bd47bb961694c0f38950246', 'hex');

// Compacted tree check
const ROOT_100K = Buffer.from(
  '11bc95fa048c55a4af9bd8d4a50c8e4564b03618f8729bfe582713ba3246fba6', 'hex');

// Zero key, proof of non-existence.
const KEY = Buffer.alloc(32, 0x00);
// Expected collision key.
const COLLISION_KEY = Buffer.from(
  '00000007635ec9d18d935cd979ed47535486dd858e7e46b4e1b9d6c0deda02e3', 'hex');

// Zero key for brontide.
const ZERO_KEY = Buffer.alloc(33, 0x00);

const MAX_PRIORITY = 10;

class NodesHealthChecker extends EventEmitter {
  constructor(options) {
    super();

    this.options = new NodesHealthCheckerOptions(options);
    this.logger = this.options.logger.context('nodes') || Logger.global;
    this.current = 0;
    this.agent = this.options.agent;

    // Prio queue for node checks.
    //  0 - highest priority for seed nodes.
    //  1 > - lower priority for other nodes, they will
    //  degrade after consecutive failures.
    this.queue = new Heap(comparePrioQueue);
    this.priorities = new Map();
    this.tracking = new Set();
    this.timeouts = new Set();

    this.loop = null;
  }

  /**
   * Start the pool.
   * @returns {Promise}
   */

  async open() {
    if (!this.options.nodesEnabled)
      return;

    this.logger.info('Starting node health checks.');

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

    this.logger.info('Stopping node health checks.');

    for (const timeout of this.timeouts) {
      clearTimeout(timeout);
      this.delete(timeout);
    }
  }

  /**
   * Start node checks.
   */

  startLoop() {
    this.logger.debug('Starting node checks. %d nodes in queue.',
      this.queue.size());

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

    this.logger.debug('Scheduling node check for "%s"(%d). C: %d, Q: %d, T: %d',
      hostname, priority, this.current, this.queue.size(), this.timeouts.size);

    this.tracking.add(hostname);
    this.priorities.set(hostname, priority);

    const timeout = setTimeout(() => {
      this.logger.debug('Pushing node check for "%s"(%d). C: %d, Q: %d, T: %d',
        hostname, priority,
        this.current, this.queue.size() + 1, this.timeouts.size - 1);
      this.queue.insert(new PeerItem(hostname, priority));
      this.timeouts.delete(timeout);
    }, time);

    this.timeouts.add(timeout);
  }

  /**
   * Check Node health.
   * @param {String} hostname
   * @returns {Promise}
   */

  checkNode(hostname) {
    const time = Date.now();
    const addr = NetAddress.fromHostname(hostname, this.options.network);

    this.logger.debug('Checking node "%s"(%d). C: %d, Q: %d, T: %d',
      hostname, this.priorities.get(hostname),
      this.current, this.queue.size(), this.timeouts.size);

    const info = {
      time,
      hostname: addr.hostname,
      host: addr.host,
      port: addr.port,
      key: addr.key.toString('hex'),
      error: null,
      result: null,
      frequency: this.options.nodesCheckFrequency,
      interval: this.options.nodesCheckInterval
    };

    this.checkNodeDetails(addr)
      .then((result) => {
        info.result = result;
        this.emit('node-success', info);
      }).catch((err) => {
        info.error = err.message;
        this.emit('node-fail', info);

        // recalculate priority
        const priority = this.priorities.get(hostname);

        // Priority 0 is reserved for seed nodes.
        if (priority === 0)
          return;

        // TODO: Maybe remove the max priority.
        if (priority >= MAX_PRIORITY)
          return;

        this.priorities.set(hostname, priority + 1);
      }).finally(() => {
        this.scheduleCheck(hostname, this.priorities.get(hostname));
        this.current -= 1;
      });
  }

  /**
   * Add node to the pool.
   * @param {NetAddress} addr
   * @returns {Promise<Object>} - result.
   */

  async checkNodeDetails(addr) {
    let peer, timeout, onError;
    let info = null;
    const chainInfo = {
      pruned: null,
      treeCompacted: null
    };

    const cleanup = () => {
      peer.removeListener('error', onError);
      peer.destroy();
      clearTimeout(timeout);
    };

    const options = {
      services: 0,
      agent: this.options.agent,
      noRelay: true,
      identityKey: this.options.identityKey
    };

    peer = new Peer(options);

    return new Promise((resolve, reject) => {
      onError = (err) => {
        reject(err);
        cleanup();
      };

      peer.on('error', onError);

      setTimeout(() => {
        reject(new Error('Timeout'));
        cleanup();
      }, this.options.nodesCheckTimeout * 2);

      peer.connect(addr);
      peer.open()
        .then(async () => {
          info = {
            version: peer.version,
            services: peer.services,
            height: peer.height,
            agent: peer.agent,
            noRelay: peer.noRelay,
            brontide: !addr.key.equals(ZERO_KEY)
          };

          if (this.options.nodesCheckPrune)
            chainInfo.pruned = await this.checkPrune(peer);
        })
        .then(async () => {
          if (!this.options.nodesDiscoverNew)
            return;

          const addrs = await this.discoverNew(peer);
          let added = 0;
          this.logger.spam('Received %d addrs.', addrs.length);

          for (const addr of addrs) {
            if (this.tracking.has(addr.hostname))
              continue;

            added += 1;
            this.scheduleCheck(addr.hostname, 1, 0);
          }

          this.logger.spam('Added %d new node checks to the queue.', added);
        })
        .then(async () => {
          if (!this.options.nodesCheckCompact) {
            resolve({
              peer: info,
              chain: chainInfo
            });
            return;
          }

          // We do this last because Compcated node will disconnect us.
          peer.removeListener('error', onError);
          chainInfo.treeCompacted = await this.checkCompact(peer);
          resolve({
            peer: info,
            chain: chainInfo
          });
        })
        .catch((err) => {
          reject(err);
        })
        .finally(() => {
          cleanup();
          peer.destroy();
        });
    });
  }

  /**
   * Discover new nodes.
   * @param {Peer} peer
   * @returns {Promise}
   */

  async discoverNew(peer) {
    let timeout;

    const cleanup = () => {
      clearTimeout(timeout);
      peer.onPacket = null;
    };

    return new Promise((resolve, reject) => {
      setTimeout(() => {
        reject(new Error('Timeout'));
        cleanup();
      }, this.options.nodesCheckTimeout);

      const addrs = [];

      const onPacket = (packet) => {
        switch (packet.type) {
          case packetTypes.ADDR: {
            for (const addr of packet.items)
              addrs.push(addr);

            if (addrs.length < 1000) {
              resolve(addrs);
              cleanup();
            }
          }
        }
      };

      peer.onPacket = onPacket;
      peer.sendGetAddr();
    });
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
    this.identityKey = secp256k1.privateKeyGenerate();

    // 5 minutes
    this.nodesEnabled = true;
    this.nodesCheckFrequency = 5 * 60 * 1000;
    // how frequently to check list of pending requests.
    this.nodesCheckInterval = 500;
    // timeout to wait for node to respond.
    this.nodesCheckTimeout = 10 * 1000;

    // node connections only
    this.nodesCheckParallel = 20;

    // Default for main is in fromOptions.
    this.nodes = [];
    this.nodesDiscoverNew = false;

    // this.nodesCheckBrontide = true;
    this.nodesCheckPrune = true;
    this.nodesCheckCompact = true;

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

    if (options.identityKey != null) {
      assert(Buffer.isBuffer(options.identityKey),
        'Identity key must be a buffer.');
      assert(secp256k1.privateKeyVerify(options.identityKey),
        'Invalid identity key.');
      this.identityKey = options.identityKey;
    }

    return this;
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
