var sax = require('sax'),
    request = require('request'),
    async = require('async'),
    qs = require('querystring'),
    EventEmitter = require('events').EventEmitter,
    util = require('util'),
    net = require('net');


var RokuTest = function (host_or_ip, dev_password, dev_port) {
  this.host = host_or_ip;
  this.baseUrl = 'http://' + host_or_ip + ':8060/';
  this.commandQueue = [];
  this.queued = false;
  this.debugSocket = null;
  //console.log("baseUrl = " + this.baseUrl);
  this.devPassword = dev_password;
  this.devPort = dev_port;
  this.connectDebug(dev_port);
};

util.inherits(RokuTest, EventEmitter);

// Define key constants
[
'Home',
'Rev',
'Fwd',
'Play',
'Select',
'Left',
'Right',
'Down',
'Up',
'Back',
'InstantReplay',
'Info',
'Backspace',
'Search',
'Enter',
].forEach(function(name) {
  Object.defineProperty(RokuTest, name.toUpperCase(), {
    enumerable: true,
    value: name
  });
});

/**
 * Optional constants to monitor development logs
 */
var ports = new Map();
ports.set(8085, "main");
ports.set(8089, "sg");
ports.set(8090, "task1");
ports.set(8091, "task2");
ports.set(8092, "task3");
ports.set(8093, "task4x");
ports.set(8080, "profiler");
ports.forEach(function (portName, portId) {
 Object.defineProperty(RokuTest, portName.toUpperCase(), {
   enumerable: true,
   value: portId
 });
});

RokuTest.prototype.type = function(string, fn) {
  var press = this.press.bind(this);

  string.split('').forEach(function(key) {
    press('Lit_' + escape(key), fn);
  }, fn);
};

RokuTest.prototype.press = function(string, fn) {
  this.commandQueue.push(function(callback) {
    request.post(this.baseUrl + 'keypress/' + string, callback);
  }.bind(this));

  this.processQueue();
};

RokuTest.prototype.delay = function(ms, fn) {
  this.commandQueue.push(function(callback) {
    setTimeout(function() {
      fn && fn();
      callback();
    }, ms);
  });

  this.processQueue();
};


// TODO: need better tests for this, not sure if it's actually working
RokuTest.prototype.input = function(obj, fn) {
  var url = this.baseUrl + 'input?' + qs.stringify(obj);
  request.post(url, function(e, r, b) {
    fn && fn(e);
  });
};

RokuTest.prototype.apps = function(fn) {
  var parser = sax.createStream();
  request.get(this.baseUrl + 'query/apps').pipe(parser).on('error', fn);

  var result = [], pending = null;
  parser.on('opentag', function(node) {
    if (node.name === 'APP') {
      pending = {
        id: parseInt(node.attributes.ID, 10),
        version: node.attributes.VERSION
      };
    }
  });

  parser.on('text', function(name) {
    name = name.trim();
    if (pending && name) {
      pending.name = name;
      result.push(pending);
      pending = null;
    }
  });

  parser.on('end', function() {
    fn(null, result);
  });
};

RokuTest.prototype.createIconStream = function(appId) {
  return request.get(this.baseUrl + 'query/icon/' + appId);
};

RokuTest.prototype.launch = function(a, fn) {
  var baseUrl = this.baseUrl;

  if (typeof a === "object") {
    this.launchWithArgs(a, fn);
  }
  else if (a.indexOf('://') > -1) {
    this.commandQueue.push(function(callback) {
      request({
        url: a,
        method: 'HEAD'
      }, function(e, res, body) {
        this.launchWithArgs('dev', {
          url: a,
          streamformat : res.headers['content-type'].split('/').pop(),
        }, fn);
      });
    }.bind(this));
  }
  else {
    this.commandQueue.push(function(callback) {

      name = a.toLowerCase();
      this.apps(function(e, results) {
      if (e) return fn(e);

        for (var i=0; i<results.length; i++) {
          if (results[i].name.toLowerCase() === name) {
            this.launchWithArgs(results[i].id.toString(), {}, fn);
            break;
          }
        }
      });
    }.bind(this));
  }

  this.processQueue();
};

RokuTest.prototype.launchWithArgs = function(name, args, fn) {
  var baseUrl = this.baseUrl;
  this.commandQueue.push(function(callback) {
    var url = baseUrl + 'launch/' + name + '?' + qs.stringify(args);
    request.post(url, function(e, r, b) {
      //console.log("Launch returned " + r.statusCode);
      callback(e)
      fn && fn(e)
    });
  }.bind(this));

  this.processQueue();
};

RokuTest.prototype.install = function(zip) {
  this.commandQueue.push(function(callback) {
    var url = 'http://' + this.host + '/plugin_install';
    var formData = {
      mysubmit: 'Install',
      passwd: '',
      archive: zip
    };
    var auth = {
      user: 'rokudev',
      pass: this.devPassword,
      sendImmediately: false
    };

    request.post({url: url, formData: formData, auth: auth }, function(e, r, b) {
      //console.log('Install returned ' + r.statusCode);
      callback(e);
    });
  }.bind(this));

  this.processQueue();
};

RokuTest.prototype.info = function(fn) {
  var parser = sax.createStream({ strict: true });
  request.get(this.baseUrl).pipe(parser).on('error', fn);

  var ret = {}, where = [], currentNode;

  parser.on('opentag', function(node) {
    where.unshift({});
    currentNode = node;
  });

  parser.on('text', function(value) {
    value = value.trim();
    if (value && currentNode) {
      ret[currentNode.name] = value;
    }
  });

  parser.on('end', function() {
    fn(null, ret);
  });
};

RokuTest.prototype.connectDebug = function(port) {
  this.destroyDebug();
  this.debugSocket = new net.Socket();

  this.commandQueue.push(function(callback) {
    this.debugSocket.connect({ port: port, host: this.host }, function() {
      //console.log("Debug log connected");

      // temporary sink for debug log history
      this.debugSocket.on('data', function(data) {
        // the telnet server writes the last n lines of log on connect. Ignore them here.
        //console.log("ignoring " + data.length + " bytes");
      });
      callback();
    }.bind(this));
  }.bind(this));

  this.delay(1000, function() {
    //console.log("Removing sink reader");
    this.debugSocket.removeAllListeners('data');
    // now set up the real listener
    this.debugSocket.on('data', function(data) {
      data.toString().split("\r\n").map(function(s) {
        s = s.trim();
        if (s.length > 0) {
          //console.log("Sending " + s.length + " bytes to test: " + s);
          this.emit('debugData', s);
        }
      }, this);
    }.bind(this));
  }.bind(this));

  this.processQueue();
};

RokuTest.prototype.destroyDebug = function() {
  if (this.debugSocket !== null) {
    this.debugSocket.destroy();
    this.debugSocket = null;
  }
};

RokuTest.prototype.processQueue = function() {
  var that = this;
  if (!this.queued) {
    var queue = this.commandQueue;
    this.queued = true;
    async.whilst(function() {
      return queue.length;
    }, function(fn) {
      queue.shift()(fn)
    }, function() {
      that.queued = false;
    })
  }
};


module.exports = RokuTest;
