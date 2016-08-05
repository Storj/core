'use strict';

var inherits = require('util').inherits;
var stream = require('readable-stream');
var StorageAdapter = require('../adapter');
var StorageItem = require('../item');

/**
 * Implements an in-memory storage adapter
 * @extends {StorageAdapter}
 * @constructor
 * @license AGPL-3.0
 */
function RAMStorageAdapter() {
  if (!(this instanceof RAMStorageAdapter)) {
    return new RAMStorageAdapter();
  }

  this._items = {};
  this._shards = {};
}

inherits(RAMStorageAdapter, StorageAdapter);

/**
 * Implements the abstract {@link StorageAdapter#_get}
 * @private
 * @param {String} key
 * @param {Function} callback
 */
RAMStorageAdapter.prototype._get = function(key, callback) {
  var self = this;
  var result = this._items[key];

  if (!result) {
    return callback(new Error('Shard data not found'));
  }

  if (this._shards[key]) {
    result.shard = new stream.Readable({
      read: function() {
        if (this._finished) {
          this.push(null);
        } else {
          this.push(self._shards[key]);
          this._finished = true;
        }
      }
    });
  } else {
    result.shard = new stream.Writable({
      write: function(data, encoding, next) {
        self._shards[key] = data;
        next();
      }
    });
  }

  callback(null, new StorageItem(result));
};

/**
 * Implements the abstract {@link StorageAdapter#_peek}
 * @private
 * @param {String} key
 * @param {Function} callback
 */
RAMStorageAdapter.prototype._peek = function(key, callback) {
  if (!this._items[key]) {
    return callback(new Error('Shard data not found'));
  }

  callback(null, new StorageItem(this._items[key]));
};

/**
 * Implements the abstract {@link StorageAdapter#_put}
 * @private
 * @param {String} key
 * @param {StorageItem} item
 * @param {Function} callback
 */
RAMStorageAdapter.prototype._put = function(key, item, callback) {
  this._items[key] = item;

  callback();
};

/**
 * Implements the abstract {@link StorageAdapter#_del}
 * @private
 * @param {String} key
 * @param {Function} callback
 */
RAMStorageAdapter.prototype._del = function(key, callback) {
  delete this._shards[key];

  callback();
};

/**
 * Implements the abstract {@link StorageAdapter#_size}
 * @private
 * @param {Function} callback
 */
RAMStorageAdapter.prototype._size = function(callback) {
  var shardBytes = 0;

  for (var key in this._shards) {
    shardBytes += this._shards[key].length;
  }

  callback(
    null,
    Buffer(JSON.stringify(this._items)).length + shardBytes
  );
};

/**
 * Implements the abstract {@link StorageAdapter#_keys}
 * @private
 * @param {Function} callback
 */
RAMStorageAdapter.prototype._keys = function(callback) {
  callback(null, Object.keys(this._items));
};

module.exports = RAMStorageAdapter;
