'use strict';

var util = require('util');
var ThaliPeerPoolInterface = require('./thaliPeerPoolInterface');
var thaliConfig = require('../thaliConfig');
var ForeverAgent = require('forever-agent');
var logger = require('../../ThaliLogger')('thaliPeerPoolOneAtATime');
var Utils = require('../utils/common.js');
var Promise = require('lie');
var PromiseQueue = require('../promiseQueue');
var ThaliReplicationPeerAction = require('../replication/thaliReplicationPeerAction');
var assert = require('assert');

/** @module thaliPeerPoolOneAtATime */

/**
 * @classdesc This is the default implementation of the
 * {@link module:thaliPeerPoolInterface~ThaliPeerPoolInterface} interface.
 *
 * WARNING: This code is really just intended for use for testing and
 * prototyping. It is not intended to be shipped.
 *
 * How the default implementation function depends on what connection type an
 * action is associated with.
 *
 * # Wifi
 *
 * When we run on Wifi we pretty much will allow all submitted actions to
 * run in parallel. The real control on their behavior is that they will
 * all share the same http agent pool so this will limit the total number
 * of outstanding connections. As we gain more operational experience I
 * expect we will determine a certain number of replications that make
 * sense to run in parallel and then we will throttle to just allowing
 * that number of connections to run in parallel, but not today. Today they
 * all run, just the pool controls them.
 *
 *
 * # Multipeer Connectivity Framework
 *
 * This one is tough because it all depends on if we have WiFi or just
 * Bluetooth. For now we will just cheat and treat this the same as WiFi above
 * except that we will use a dedicated http agent pool (no reason so share
 * with WiFi).
 *
 * # Bluetooth
 *
 * We have written
 * [an article](http://www.thaliproject.org/androidWirelessIssues) about all
 * the challenges of making Bluetooth behave itself. There are different
 * tradeoffs depending on the app. For now we mostly test with chat apps
 * that don't move a ton of data and when we do test large amounts of data
 * we set up the test to only try one connection at a time. So for now we
 * aren't going to try to regulate how many connections, incoming or outgoing
 * we have. Instead we will give each client connection its own HTTP
 * agent pool and call it a day.
 *
 * # Connection pooling
 *
 * We owe each action an Agent to manage their connection count. The tricky
 * part here is that while we can re-use connections when we are talking to
 * the same peer, we can't re-use them across peers because the PSK will be
 * different. So in theory we have to create a new agent for each action but
 * for bonus points we could detect when we see the same peerID across two
 * different actions and have them share the same pool. We aren't going to
 * bother being that smart for right now.
 *
 * @public
 * @constructor
 */
function ThaliPeerPoolOneAtATime() {
  ThaliPeerPoolOneAtATime.super_.call(this);
  this._stopped = true;
  this._serialPromiseQueue = new PromiseQueue();
  this._wifiReplicationCount = {};
}

util.inherits(ThaliPeerPoolOneAtATime, ThaliPeerPoolInterface);
ThaliPeerPoolOneAtATime.ERRORS = ThaliPeerPoolInterface.ERRORS;

ThaliPeerPoolOneAtATime.ERRORS.ENQUEUE_WHEN_STOPPED = 'We are stopped';

ThaliPeerPoolOneAtATime.prototype._startAction = function (peerAction) {
  var actionAgent = new ForeverAgent.SSL({
    keepAlive: true,
    keepAliveMsecs: thaliConfig.TCP_TIMEOUT_WIFI/2,
    maxSockets: Infinity,
    maxFreeSockets: 256,
    ciphers: thaliConfig.SUPPORTED_PSK_CIPHERS,
    pskIdentity: peerAction.getPskIdentity(),
    pskKey: peerAction.getPskKey()
  });

  return peerAction.start(actionAgent)
  .then(function () {
    logger.debug('action returned successfully from start');
    return null;
  })
  .catch(function (err) {
    logger.debug('action returned with error from start' + err);
    return null;
  });
};

ThaliPeerPoolOneAtATime.prototype._wifiReplicationCount = null;

ThaliPeerPoolOneAtATime.prototype._wifiEnqueue = function (peerAction) {
  var self = this;
  if (peerAction.getActionType() !== ThaliReplicationPeerAction.actionType) {
    return self._startAction(peerAction);
  }

  var peerId = peerAction.getPeerIdentifier();

  var count = self._wifiReplicationCount[peerId];
  switch (count) {
    case undefined:
    case 0: {
      self._wifiReplicationCount[peerId] = 1;
      break;
    }
    case 1: {
      self._wifiReplicationCount[peerId] = 2;
      break;
    }
    case 2: {
      return peerAction.kill();
    }
    default: {
      logger.error('We got an illegal count: ' + count);
    }
  }

  var originalKill = peerAction.kill;
  peerAction.kill = function () {
    var count = self._wifiReplicationCount[peerId];
    switch (count) {
      case 1: {
        delete self._wifiReplicationCount[peerId];
        break;
      }
      case 2: {
        self._wifiReplicationCount[peerId] = 1;
        break;
      }
      default: {
        logger.error('Count had to be 1 or 2 - ' + count);
      }
    }
    return originalKill.apply(this, arguments);
  };

  return self._startAction(peerAction);
};

ThaliPeerPoolOneAtATime.prototype._bluetoothEnqueue = function (peerAction) {
  /*
  For Bluetooth we will issue exactly one action at a time. So don't test more
  than two phones over native because there are conditions where the phones
  can get stuck in a cycle and lock one of the phones out for awhile.

  The easy issue is running actions one at a time. The serialPromiseQueue is
  perfect for that.

  The challenge is knowing when to terminate connections.

  For notification actions if we get any result but BEACONS_RETRIEVED_AND_PARSED
  with beacons set to a non-null value then we should call
  terminateOutgoingConnection just to be safe. The trick though is that we HAVE
  to make sure that the next action is going to be the replication action.
  Otherwise we can get an already connected error. So what we have to do is
  when we get a magic result from the notification action

  For replication actions we should always call terminateOutgoingConnection. If
  we get a completed replication action then it means they have stopped playing
  with the phones and we should give them a chance to connect to someone else.
   */
};

ThaliPeerPoolOneAtATime.prototype.enqueue = function (peerAction) {
  if (this._stopped) {
    throw new Error(ThaliPeerPoolOneAtATime.ERRORS.ENQUEUE_WHEN_STOPPED);
  }

  // Right now we will just allow everything to run parallel.

  var result =
    ThaliPeerPoolOneAtATime.super_.prototype.enqueue.apply(this, arguments);


  // We hook our clean up code to kill and it is always legal to call
  // kill, even if it has already been called. So this ensures that our
  // cleanup code gets called regardless of how the action ended.
  this._serialPromiseQueue.enqueue(function (resolve, reject) {
    logger.debug(peerAction.getId() + ' - Peer Action Started');
    return peerAction.start(actionAgent)
      .catch(function (err) {
        logger.debug('Got err ', Utils.serializePouchError(err));
      })
      .then(function () {
        logger.debug(peerAction.getId() + ' - Peer Action Stopped');
        peerAction.kill();
        resolve(true);
      });
  });


  return result;
};

ThaliPeerPoolOneAtATime.prototype.start = function () {
  this._stopped = false;

  return ThaliPeerPoolOneAtATime.super_.prototype.start.apply(this, arguments);
};

/**
 * This function is used primarily for cleaning up after tests and will
 * kill any actions that this pool has started that haven't already been
 * killed. It will also return errors if any further attempts are made
 * to enqueue.
 */
ThaliPeerPoolOneAtATime.prototype.stop = function () {
  this._stopped = true;
  this._wifiReplicationCount = {};
  return ThaliPeerPoolOneAtATime.super_.prototype.stop.apply(this, arguments);
};

module.exports = ThaliPeerPoolOneAtATime;
