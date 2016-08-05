'use strict';

var fs = require('fs');
var async = require('async');
var merge = require('merge');

/**
 * Internal state machine used by {@link BridgeClient}
 * @constructor
 * @license LGPL-3.0
 * @param {Object} options
 * @param {String} options.id - Bucket ID for the upload state
 * @param {String} options.file - Path to the file to track
 * @param {Function} options.onComplete - Reference to callback after complete
 */
function UploadState(options) {
  if (!(this instanceof UploadState)) {
    return new UploadState(options);
  }

  options = merge(Object.create(UploadState.DEFAULTS), options);

  this.bucketId = options.id;
  this.file = options.file;
  this.cleanQueue = [];
  this.numShards = options.numShards;
  this.completed = 0;
  this.callback = options.onComplete;
  this.concurrency = options.concurrency;
  this.queue = async.queue(options.worker, this.concurrency);
}

UploadState.DEFAULTS = {
  concurrency: 6
};

/**
 * Unlinks the referenced tmp files
 */
UploadState.prototype.cleanup = function() {
  this.cleanQueue.forEach(function(tmpFilePath) {
    if (fs.existsSync(tmpFilePath)) {
      fs.unlinkSync(tmpFilePath);
    }
  });
};

module.exports = UploadState;
