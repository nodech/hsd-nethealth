/*!
 * nethealth.js - Export everything from nethealth for convenience.
 * Copyright (c) 2024, Nodari Chkuaselidze (MIT License)
 */

'use strict';

const NodesHealthChecker = require('./lib/nodescheck');
const DNSHealthChecker = require('./lib/dnscheck');
const NetCheckNode = require('./lib/netcheck');

exports.NetCheckNode = NetCheckNode;
exports.NodesHealthChecker = NodesHealthChecker;
exports.DNSHealthChecker = DNSHealthChecker;
