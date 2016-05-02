'use strict';

var FSStorageAdapter = require('../../../lib/storage/adapters/fs');
var StorageItem = require('../../../lib/storage/item');
var expect = require('chai').expect;
var utils = require('../../../lib/utils');
var Contract = require('../../../lib/contract');
var Audit = require('../../../lib/audit');
var proxyquire = require('proxyquire');

function tmpdir() {
  return require('os').tmpdir() + '/' + Date.now();
}

describe('FSStorageAdapter', function() {

  var store = new FSStorageAdapter(tmpdir());
  var hash = utils.rmd160('test');
  var audit = new Audit({ shard: new Buffer('test'), audit: 12 });
  var contract = new Contract();
  var item = new StorageItem({
    hash: hash,
    shard: new Buffer('test')
  });

  describe('@constructor', function() {

    it('should create instance without the new keyword', function() {
      expect(FSStorageAdapter(tmpdir())).to.be.instanceOf(FSStorageAdapter);
    });

  });

  describe('#_put', function() {

    it('should store the item', function(done) {
      item.contracts[hash] = contract;
      item.challenges[hash] = audit.getPrivateRecord();
      item.trees[hash] = audit.getPublicRecord();
      store._put(hash, item, function(err) {
        expect(err).equal(null);
        done();
      });
    });

  });

  describe('#_get', function() {

    it('should return the stored item', function(done) {
      store._get(hash, function(err, item) {
        expect(err).to.equal(null);
        expect(item).to.be.instanceOf(StorageItem);
        done();
      });
    });

  });

  describe('#_keys', function() {

    it('should filter out any invalid dirnames', function(done) {
      var BadStorageAdapter = proxyquire('../../../lib/storage/adapters/fs', {
        fs: {
          existsSync: function() {
            return true;
          },
          readdir: function(path, cb) {
            cb(null, [
              '1315fb9624340229e723a046b0214acd33747b6a',
              '1315fb9624340229e723a046b0214acd33747b6b',
              '.DS_Store',
              'Thumbs.db',
              '1315fb9624340229e723a046b0214acd33747b6c',
              '1315fb9624340229e723a046b0214acd33747b6e'
            ]);
          }
        }
      });
      var adapter = new BadStorageAdapter(tmpdir());
      adapter._keys(function(err, keys) {
        expect(keys).to.have.lengthOf(4);
        expect(keys.indexOf('.DS_Store')).to.equal(-1);
        expect(keys.indexOf('Thumbs.db')).to.equal(-1);
        done();
      });
    });

    it('should bubble error from fs.readdir', function(done) {
      var BadStorageAdapter = proxyquire('../../../lib/storage/adapters/fs', {
        fs: {
          existsSync: function() {
            return true;
          },
          readdir: function(path, cb) {
            cb(new Error('teh filez are \'sploded'));
          }
        }
      });
      var adapter = new BadStorageAdapter(tmpdir());
      adapter._keys(function(err) {
        expect(err.message).to.equal('teh filez are \'sploded');
        done();
      });
    });

  });

});
