'use strict';

var assert = require('assert');
var fs = require('fs');
var querystring = require('querystring');
var request = require('request');
var utils = require('./utils');
var FileDemuxer = require('./filedemuxer');
var FileMuxer = require('./filemuxer');
var AuditStream = require('./auditstream');
var DataChannelClient = require('./datachannel/client');
var Contact = require('./network/contact');
var crypto = require('crypto');
var tmpdir = require('os').tmpdir();
var path = require('path');
var mime = require('mime');
var uuid = require('node-uuid');
var merge = require('merge');
var Logger = require('kad-logger-json');
var EventEmitter = require('events').EventEmitter;
var UploadState = require('./uploadstate');
var stream = require('readable-stream');
var async = require('async');

/**
 * Represents a client interface to a given bridge server
 * @constructor
 * @license LGPL-3.0
 * @see https://github.com/storj/bridge
 * @param {String} uri - API base URI ('https://api.storj.io')
 * @param {Object} options
 * @param {KeyPair} options.keypair - KeyPair instance for request signing
 * @param {Object} options.logger - Logger instance
 * @param {Number} options.concurrency - Upload concurrency limit
 * @param {Number} options.transferRetries - Limit number of shard transfer
 * retries before getting a new contract
 * @param {Object} options.basicauth
 * @param {String} options.basicauth.email - Email address for HTTP basic auth
 * @param {String} options.basicauth.password - Password for HTTP basic auth
 */
function BridgeClient(uri, options) {
  if (!(this instanceof BridgeClient)) {
    return new BridgeClient(uri, options);
  }

  this._options = this._checkOptions(uri, options);
  this._logger = this._options.logger;
  this._transferConcurrency = this._options.concurrency;
}

/**
 * Check the options supplied to the constructor
 * @private
 */
BridgeClient.prototype._checkOptions = function(uri, options) {
  options = merge({
    baseURI: uri || process.env.STORJ_BRIDGE || 'https://api.storj.io',
    logger: new Logger(0),
    concurrency: 6,
    transferRetries: 3
  }, options);

  assert.ok(utils.validateLogger(options.logger), 'Invalid logger supplied');

  return options;
};

/**
 * Get the remote Storj Bridge API documentation and version as JSON
 * @param {Function} callback
 */
BridgeClient.prototype.getInfo = function(callback) {
  return this._request('GET', '/', {}, callback);
};

/**
 * Fetches the list of known contacts filtered according to the options
 * @param {Object} options
 * @param {Number} options.page - The page number of the contact list to fetch
 * @param {Boolean} options.connected - Filter results by connection status
 * @param {Function} callback
 */
BridgeClient.prototype.getContactList = function(options, callback) {
  return this._request('GET', '/contacts', options, callback);
};

/**
 * Get the contact information for the given nodeID
 * @param {String} nodeId - The nodeID of the contact
 * @param {Function} callback
 */
BridgeClient.prototype.getContactByNodeId = function(nodeId, callback) {
  return this._request('GET', '/contacts/' + nodeId, {}, callback);
};

/**
 * Registers a user account
 * @param {Object} options
 * @param {String} options.email - Email address for verification email
 * @param {String} options.password - Password to register (auto hashed)
 * @param {String} options.redirect - URL to redirect to after verification
 * @param {String} options.pubkey - Optional ECDSA public key to register
 * @param {Function} callback
 */
BridgeClient.prototype.createUser = function(options, callback) {
  return this._request('POST', '/users', {
    email: options.email,
    password: utils.sha256(options.password, 'utf8'),
    redirect: options.redirect,
    pubkey: options.pubkey
  }, callback);
};

/**
 * Deactivates a user account
 * @param {Object} options
 * @param {String} options.email - Email address of user to deactivate
 * @param {String} options.redirect - URL to redirect after verification
 * @param {Function} callback
 */
BridgeClient.prototype.destroyUser = function(options, callback) {
  return this._request('DELETE', '/users/' + options.email, {
    redirect: options.redirect
  }, callback);
};

/**
 * Requests a password reset
 * @param {Object} options
 * @param {String} options.email - Email address of user to reset password
 * @param {String} options.password - The cleartext password to reset to
 * @param {String} options.redirect - URL to redirect adter confirmation
 * @param {Function} callback
 */
BridgeClient.prototype.resetPassword = function(options, callback) {
  return this._request('PATCH', '/users/' + options.email, {
    password: utils.sha256(options.password, 'utf8'),
    redirect: options.redirect
  }, callback);
};

/**
 * Returns list of associated public keys
 * @param {Function} callback
 */
BridgeClient.prototype.getPublicKeys = function(callback) {
  return this._request('GET', '/keys', {}, callback);
};

/**
 * Registers a public key for the caller
 * @param {String} pubkey - Hex encoded ECDSA (secp256k1) public key
 * @param {Function} callback
 */
BridgeClient.prototype.addPublicKey = function(pubkey, callback) {
  return this._request('POST', '/keys', { key: pubkey }, callback);
};

/**
 * Disassociates the public key from the caller
 * @param {String} pubkey - Hex encoded ECDSA (secp256k1) public key
 * @param {Function} callback
 */
BridgeClient.prototype.destroyPublicKey = function(pubkey, callback) {
  return this._request('DELETE', '/keys/' + pubkey, {}, callback);
};

/**
 * Lists the caller's file buckets
 * @param {Function} callback
 */
BridgeClient.prototype.getBuckets = function(callback) {
  return this._request('GET', '/buckets', {}, callback);
};

/**
 * Returns the bucket information by ID
 * @param {String} id - Unique bucket ID
 * @param {Function} callback
 */
BridgeClient.prototype.getBucketById = function(id, callback) {
  return this._request('GET', '/buckets/' + id, {}, callback);
};

/**
 * Creates a new file bucket
 * @param {Object} data - Bucket parameters for creation
 * @param {Function} callback
 */
BridgeClient.prototype.createBucket = function(data, callback) {
  return this._request('POST', '/buckets', data, callback);
};

/**
 * Removes the bucket
 * @param {String} id - Unique bucket ID
 * @param {Function} callback
 */
BridgeClient.prototype.destroyBucketById = function(id, callback) {
  return this._request('DELETE', '/buckets/' + id, {}, callback);
};

/**
 * Updates the bucket
 * @param {String} id - Unique bucket ID
 * @param {Object} updates - Bucket update parameters
 * @param {Function} callback
 */
BridgeClient.prototype.updateBucketById = function(id, updates, callback) {
  return this._request('PATCH', '/buckets/' + id, updates, callback);
};

/**
 * Lists the files stored in a bucket
 * @param {String} id - Unique bucket ID
 * @param {Function} callback
 */
BridgeClient.prototype.listFilesInBucket = function(id, callback) {
  return this._request('GET', '/buckets/' + id + '/files', {}, callback);
};

/**
 * Create bucket token
 * @param {String} id - Unique bucket ID
 * @param {String} operation - PUSH or PULL (file operation)
 * @param {Function} callback
 */
BridgeClient.prototype.createToken = function(id, operation, callback) {
  return this._request('POST', '/buckets/' + id + '/tokens', {
    operation: operation
  }, callback);
};

/**
 * Removes a file from a bucket
 * @param {String} id - Unique bucket ID
 * @param {String} file - ID of the file to remove from bucket
 * @param {Function} callback
 */
BridgeClient.prototype.removeFileFromBucket = function(id, file, callback) {
  return this._request(
    'DELETE',
    '/buckets/' + id + '/files/' + file,
    {},
    callback
  );
};

/**
 * Creates a file staging frame
 * @param {Function} callback
 */
BridgeClient.prototype.createFileStagingFrame = function(callback) {
  return this._request('POST', '/frames', {}, callback);
};

/**
 * Creates a file staging frame
 * @param {Function} callback
 */
BridgeClient.prototype.getFileStagingFrames = function(callback) {
  return this._request('GET', '/frames', {}, callback);
};

/**
 * Creates a file staging frame
 * @param {String} id - Unique frame ID
 * @param {Function} callback
 */
BridgeClient.prototype.getFileStagingFrameById = function(id, callback) {
  return this._request('GET', '/frames/' + id, {}, callback);
};

/**
 * Creates a file staging frame
 * @param {String} id - Unique frame ID
 * @param {Function} callback
 */
BridgeClient.prototype.destroyFileStagingFrameById = function(id, callback) {
  return this._request('DELETE', '/frames/' + id, {}, callback);
};

/**
 * Creates a file staging frame
 * @param {String} id - Unique frame ID
 * @param {Object} shard - The shard metadata
 * @param {Object} options
 * @param {Number} options.retry - Retry the request this many times if failed
 * @param {Function} callback
 */
BridgeClient.prototype.addShardToFileStagingFrame = function(f, s, opt, cb) {
  var self = this;
  var retries = 0;

  if (typeof arguments[2] === 'function') {
    cb = opt;
    opt = { retry: 6 };
  }

  function _addShard() {
    self._logger.info('Adding shard metadata for %s to frame', s.hash);

    return self._request('PUT', '/frames/' + f, s, function(err, result) {
      if (err) {
        if (opt.retry > retries) {
          retries++;
          return _addShard();
        }

        return cb(err);
      }

      cb(null, result);
    });
  }

  return _addShard();
};

/**
 * Instructs the bridge to find N mirroring farmers for redundancy
 * @param {String} id - Unique bucket ID
 * @param {String} token - Token from {@link BridgeClient#createToken}
 * @param {String} file - Path to file to store
 * @param {Number} concurrency - Upload concurrency
 * @param {Function} callback
 */
BridgeClient.prototype.replicateFileFromBucket = function(id, file, n, cb) {
  if (typeof n === 'function') {
    cb = n;
    n = undefined;
  }

  return this._request('POST', '/buckets/' + id + '/mirrors', {
    file: file,
    redundancy: n
  }, cb);
};

/**
 * Stores a file in the bucket
 * @param {String} id - Unique bucket ID
 * @param {String} token - Token from {@link BridgeClient#createToken}
 * @param {String} file - Path to file to store
 * @param {Function} callback
 */
BridgeClient.prototype.storeFileInBucket = function(id, token, file, cb) {
  var self = this;
  var uploadState = new UploadState({
    id: id,
    file: file,
    onComplete: cb,
    worker: this._shardUploadWorker.bind(this),
    numShards: Math.ceil(
      fs.statSync(file).size / FileDemuxer.DEFAULTS.shardSize
    ),
    concurrency: this._transferConcurrency
  });

  self.createFileStagingFrame(function(err, frame) {
    if (err) {
      return cb(err);
    }

    var demuxer = new FileDemuxer(file);

    demuxer.on('shard', function(shardStream, index) {
      self._handleShardStream(shardStream, index, frame, uploadState);
    });
  });
};

BridgeClient.prototype._shardUploadWorker = function(task, done) {
  var self = this;

  self._logger.info(
    'Trying to upload shard %s index %s',
    task.meta.tmpName,
    task.meta.index
  );
  task.state.cleanQueue.push(task.meta.tmpName);

  task.shard.on('data', function(data) {
    task.meta.size += data.length;
    task.meta.hasher.update(data);
    task.tmpFile.write(data);
  }).resume();

  task.shard.on('end', task.tmpFile.end.bind(task.tmpFile));

  task.tmpFile.on('finish', function() {
    task.meta.hash = task.meta.hasher.digest('hex');
    self._handleShardTmpFileFinish(task.state, task.meta, done);
  });
};

/**
 * Handles a demuxed shard and writes it to tmp and updates the state
 * @private
 * @param {stream.Readable} shard - Shard stream
 * @param {Number} i  - Index of the demuxed shard
 * @param {Object} frame - Frame object returned from bridge
 * @param {UploadState} state - The upload state machine
 */
BridgeClient.prototype._handleShardStream = function(shard, i, frame, state) {
  var meta = {
    frame: frame,
    tmpName: path.join(tmpdir, crypto.randomBytes(6).toString('hex')),
    size: 0,
    index: i,
    hasher: crypto.createHash('sha256'),
    hash: null,
    excludeFarmers: [],
    transferRetries: 0
  };
  var tmpFile = fs.createWriteStream(meta.tmpName);
  var passthrough = new stream.PassThrough();

  passthrough.pause();
  state.queue.push({
    state: state,
    tmpFile: tmpFile,
    meta: meta,
    shard: shard.pipe(passthrough)
  });
};

/**
 * Generate audits for shard and add to frame
 * @private
 * @param {UploadState} state - The shard upload state machine
 * @param {Object} meta - Shard metadata reference
 * @param {Function} done - To be called on task complete
 */
BridgeClient.prototype._handleShardTmpFileFinish = function(state, meta, done) {
  var self = this;
  var hash = utils.rmd160(meta.hash);
  var auditGenerator = new AuditStream(3);
  var shardFile = fs.createReadStream(meta.tmpName);

  self._logger.info('Hash for this shard is: %s', hash);

  shardFile.pipe(auditGenerator).on('finish', function() {
    var challenges = auditGenerator.getPrivateRecord().challenges;
    var tree = auditGenerator.getPublicRecord();

    self._logger.info('Audit generation for shard done.');
    self._logger.info('Waiting on a storage offer from the network...');

    self.addShardToFileStagingFrame(meta.frame.id, {
      hash: hash,
      size: meta.size,
      index: meta.index,
      challenges: challenges,
      tree: tree,
      exclude: meta.excludeFarmers
    }, function(err, pointer) {
      if (err) {
        self._logger.warn('Failed to upload shard...');
        state.cleanup();
        return state.callback(err);
      }

      self._startTransfer(pointer, state, meta, done);
    });
  });
};

/**
 * Starts a retryable shard transfer operation
 * @private
 * @param {Object} pointer - Pointer object returned from bridge
 * @param {UploadState} state - Upload state machine
 * @param {Object} meta - Shard metadata reference
 * @param {Function} done - Task complete callback
 */
BridgeClient.prototype._startTransfer = function(pointer, state, meta, done) {
  var self = this;
  var emitter = new EventEmitter();
  var transferStatus = self._transferShard(emitter, meta.tmpName, pointer);

  self._logger.info('Contract negotiated with: %j', pointer.farmer);

  transferStatus.on('retry', function() {
    if (meta.transferRetries < self._options.transferRetries) {
      meta.transferRetries++;
      self._logger.info('Retrying shard transfer, pointer: %j', pointer);
      self._transferShard(emitter, meta.tmpName, pointer);
    } else {
      self._logger.info(
        'Shard transfer failed %s times, getting another contract...',
        meta.transferRetries
      );
      transferStatus.removeAllListeners();
      meta.excludeFarmers.push(pointer.farmer.nodeID);
      meta.transferRetries = 0;
      self._handleShardTmpFileFinish(state, meta, done);
    }
  });

  transferStatus.on('finish', self._shardTransferComplete.bind(
    self,
    state,
    meta.frame,
    done
  ));
};

/**
 * Finalizes shard transfer and if all complete adds entry to bucket
 * @private
 * @param {UploadState} state - Shard upload state machine
 * @param {Object} frame - Frame object returned from bridge
 * @param {Function} done - Task completion callback
 */
BridgeClient.prototype._shardTransferComplete = function(state, frame, done) {
  var self = this;

  state.completed++;

  self._logger.info(
    'Shard transfer completed! %s remaining...',
    state.numShards - state.completed
  );

  done();

  if (state.completed === state.numShards) {
    state.cleanup();

    // NB: use the original filename if called from cli
    var origFileName = path.basename(state.file).split('.crypt')[0];

    self._logger.info('Transfer finished, creating entry...');
    self._request('POST', '/buckets/' + state.bucketId + '/files', {
      frame: frame.id,
      mimetype: mime.lookup(origFileName),
      filename: origFileName
    }, state.callback);
  }
};

/**
 * Transfers a shard to a specified farmer
 * @param {events.EventEmitter} emitter - For getting status events
 * @param {String} tmpName - Path to shard file
 * @param {Object} pointer - Farmer Contact information
 * @param {Function} callback
 */
BridgeClient.prototype._transferShard = function(emitter, name, pointer, cb) {
  var self = this;
  var shardFile = fs.createReadStream(name);
  var client = new DataChannelClient(Contact(pointer.farmer));

  function _onErr(err) {
    self._logger.warn('Failed to transfer shard, reason: %s', err.message);
    client.removeAllListeners();
    emitter.emit('retry', name, pointer, cb);
  }

  client.on('error', _onErr).on('open', function() {
    self._logger.info('Data channel opened, transferring shard...');

    var datachannel = client.createWriteStream(
      pointer.token,
      pointer.hash
    );

    shardFile.pipe(datachannel).on('error', _onErr).on('finish', function() {
      emitter.emit('finish');
    });
  });

  return emitter;
};

/**
 * Retrieves a series of file pointers from the bucket
 * @param {Object} options
 * @param {String} options.bucket - Unique bucket ID
 * @param {String} options.token - Token from {@link BridgeClient#createToken}
 * @param {String} options.file - The unique file pointer ID
 * @param {Number} options.skip - The starting index of pointers to resolve
 * @param {Number} options.limit - The number of pointers to resolve
 * @param {Function} callback
 */
BridgeClient.prototype.getFilePointers = function(options, cb) {
  var self = this;

  request({
    method: 'GET',
    baseUrl: self._options.baseURI,
    uri: '/buckets/' + options.bucket + '/files/' + options.file,
    headers: {
      'x-token': options.token
    },
    qs: {
      skip: options.skip,
      limit: options.limit,
      exclude: Array.isArray(options.exclude) ? options.exclude.join() : null
    },
    json: true
  }, function(err, res, body) {
    if (err) {
      return cb(err);
    }

    if (res.statusCode !== 200 && res.statusCode !== 304) {
      return cb(new Error(body.error || body));
    }

    cb(null, body);
  });
};

/**
 * Create a readable datachannel stream from the supplied file pointer
 * @private
 * @param {Object} pointer
 * @param {Function} callback
 */
BridgeClient.prototype._createInputFromPointer = function(pointer, callback) {
  var dcx = new DataChannelClient(new Contact(pointer.farmer));

  dcx.on('open', function() {
    callback(null, dcx.createReadStream(pointer.token, pointer.hash));
  });

  dcx.on('error', function(err) {
    dcx.removeAllListeners('open');
    callback(err);
  });
};

/**
 * Open a series of data channels based on the returned value of
 * {@link BridgeClient#getFilePointers} to resolve all the shards and
 * reassemble them together as a binary stream
 * @param {Array} pointers - Result of {@link BridgeClient#getFilePointers}
 * @param {Function} callback
 */
BridgeClient.prototype.resolveFileFromPointers = function(pointers, callback) {
  var self = this;
  var muxer = new FileMuxer({
    shards: pointers.length,
    length: pointers.reduce(function(a, b) {
      return { size: a.size + b.size };
    }, { size: 0 }).size
  });

  function _addInputToMultiplexer(pointer, onInputAdded) {
    if (!pointer) {
      return onInputAdded();
    }

    self._createInputFromPointer(pointer, function(err, inputStream) {
      if (err) {
        err.pointer = pointer;
        return muxer.emit('error', err);
      }

      // NB: Trick the multiplexer into letting us incrementally modify it's
      // NB: internal state so we can add input sources after initialization
      if (muxer._added === muxer._shards) {
        muxer._length += pointer.size; muxer._shards++;
      }

      muxer.input(inputStream);
      onInputAdded();
    });
  }

  var queue = async.queue(_addInputToMultiplexer, 1);

  function _addPointerToInputQueue(done) {
    queue.push(pointers.shift(), done);
  }

  muxer.on('drain', _addPointerToInputQueue.bind(null, null));
  async.times(
    this._transferConcurrency,
    function addInputSource(n, next) {
      _addPointerToInputQueue(next);
    },
    function onInputsAdded() {
      callback(null, muxer, queue);
    }
  );
};

/**
 * Create a readable stream from the given bucket and file id
 * @param {String} bucket - The unique bucket ID
 * @param {String} file - The unique file ID
 * @param {Object} [options]
 * @param {Array} [options.exlude] - Exclude these nodeID's from pointers
 * @param {Function} callback - Receives (err, stream)
 */
BridgeClient.prototype.createFileStream = function(bucket, file, opt, cb) {
  var self = this;
  var skip = -6;
  var limit = 6;
  var resolved = false;

  if (typeof opt === 'function') {
    cb = opt;
    opt = {};
  }

  function _getPullToken(done) {
    self._logger.info('Creating retrieval token...');
    self.createToken(bucket, 'PULL', function(err, token) {
      if (err) {
        return done(err);
      }

      done(null, token.token);
    });
  }

  function _getPointerSlice(token, done) {
    self._logger.info('Resolving %s file pointers...', limit);
    self.getFilePointers({
      bucket: bucket,
      token: token,
      file: file,
      skip: skip += 6,
      limit: limit,
      exclude: opt.exclude
    }, function(err, pointers) {
      if (err) {
        return done(err);
      }

      done(null, pointers);
    });
  }

  function _createStreamAndQueue(pointers, done) {
    self.resolveFileFromPointers(pointers, function(err, stream, queue) {
      if (err) {
        return done(err);
      }

      done(null, stream, queue);
    });
  }

  function _resolveNextSlice(queue, done) {
    _getPullToken(function(err, token) {
      if (err) {
        return done(err);
      }

      _getPointerSlice(token, function(err, pointers) {
        if (err) {
          return done(err);
        }

        if (pointers.length === 0) {
          resolved = true;
          return done();
        }

        self._logger.info(
          'Downloading file slice from %s channels.',
          pointers.length
        );
        async.eachSeries(pointers, queue.push.bind(queue), done);
      });
    });
  }

  async.waterfall([
    _getPullToken,
    _getPointerSlice,
    _createStreamAndQueue
  ], function(err, stream, queue) {
    if (err) {
      return cb(err);
    }

    cb(null, stream); // NB: Provide the stream as soon as it is ready
    async.until(function _pointersAreExhausted() {
      return resolved;
    }, _resolveNextSlice.bind(null, queue), function(err) {
      if (err) {
        stream.emit('error', err);
      }
    });
  });
};

/**
 * Sends a request to the storj bridge
 * @private
 * @param {String} method - HTTP verb
 * @param {String} path - Endpoint path
 * @param {Object} params - Request parameters
 * @param {Function} callback - Return the raw response stream?
 */
BridgeClient.prototype._request = function(method, path, params, callback) {
  var opts = {
    baseUrl: this._options.baseURI,
    uri: path,
    method: method
  };

  params.__nonce = uuid.v4();

  if (['GET', 'DELETE'].indexOf(method) !== -1) {
    opts.qs = params;
    opts.json = true;
  } else {
    opts.json = params;
  }

  this._authenticate(opts);

  request(opts, function(err, res, body) {
    if (err) {
      return callback(err);
    }

    if (res.statusCode >= 400) {
      return callback(new Error(body.error || body));
    }

    callback(null, body);
  });
};

/**
 * Adds authentication headers to request object
 * @private
 * @param {Object} opts - Options parameter passed to request
 * @return {Object}
 */
BridgeClient.prototype._authenticate = function(opts) {
  if (this._options.keypair) {
    var payload = ['GET', 'DELETE'].indexOf(opts.method) !== -1 ?
                  querystring.stringify(opts.qs) :
                  JSON.stringify(opts.json);

    var contract = [opts.method, opts.uri, payload].join('\n');

    opts.headers = opts.headers || {};
    opts.headers['x-pubkey'] = this._options.keypair.getPublicKey();
    opts.headers['x-signature'] = this._options.keypair.sign(contract, {
      compact: false
    });
  } else if (this._options.basicauth) {
    opts.auth = {
      user: this._options.basicauth.email,
      pass: utils.sha256(this._options.basicauth.password, 'utf8')
    };
  }

  return opts;
};

module.exports = BridgeClient;
