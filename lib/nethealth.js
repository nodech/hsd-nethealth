/*!
 * nethealth.js - Export everything from nethealth for convenience.
 * Copyright (c) 2024, Nodari Chkuaselidze (MIT License)
 */

'use strict';

const NodesHealthChecker = require('./nodescheck');
const DNSHealthChecker = require('./dnscheck');
const NetCheckNode = require('./netcheck');

exports.NetCheckNode = NetCheckNode;
exports.NodesHealthChecker = NodesHealthChecker;
exports.DNSHealthChecker = DNSHealthChecker;
