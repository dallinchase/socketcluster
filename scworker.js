var socketClusterServer = require('socketcluster-server');
var EventEmitter = require('events').EventEmitter;
var crypto = require('crypto');
var domain = require('domain');
var http = require('http');

var SCWorker = function (options) {
  var self = this;
  
  self.EVENT_ERROR = 'error';
  self.EVENT_NOTICE = 'notice';
  self.EVENT_EXIT = 'exit';
  self.EVENT_READY = 'ready';
  self.EVENT_CONNECTION = 'connection';
  
  /*
    This event comes from the SocketCluster master process
  */
  self.EVENT_LEADER_START = 'leaderstart';

  this._errorDomain = domain.create();
  this._errorDomain.on('error', function () {
    self.errorHandler.apply(self, arguments);
    if (self._options.rebootWorkerOnError) {
      self.emit(self.EVENT_EXIT);
    }
  });

  this.start = this._errorDomain.bind(this._start);
  this._errorDomain.run(function () {
    self._init(options);
  });
};

SCWorker.prototype = Object.create(EventEmitter.prototype);

SCWorker.prototype._init = function (options) {
  var self = this;

  this._options = {
    transports: ['polling', 'websocket'],
    host: 'localhost'
  };

  for (var i in options) {
    this._options[i] = options[i];
  }

  if (this._options.dataKey == null) {
    this._options.dataKey = crypto.randomBytes(32).toString('hex');
  }

  this._clusterEngine = require(this._options.clusterEngine);

  this._paths = options.paths;

  this._httpRequestCount = 0;
  this._ioRequestCount = 0;
  this._httpRPM = 0;
  this._ioRPM = 0;

  this._ioClusterClient = new this._clusterEngine.IOClusterClient({
    stores: this._options.stores,
    dataKey: this._options.dataKey,
    connectTimeout: this._options.connectTimeout,
    dataExpiry: this._options.sessionTimeout,
    heartRate: this._options.sessionHeartRate,
    addressSocketLimit: this._options.addressSocketLimit
  });

  this._errorDomain.add(this._ioClusterClient);

  this._server = http.createServer();
  this._errorDomain.add(this._server);

  this._socketServer = socketClusterServer.attach(this._server, {
    sourcePort: this._options.sourcePort,
    ioClusterClient: this._ioClusterClient,
    transports: this._options.transports,
    pingTimeout: this._options.heartbeatTimeout,
    pingInterval: this._options.heartbeatInterval,
    upgradeTimeout: this._options.connectTimeout,
    host: this._options.host,
    secure: this._options.protocol == 'https',
    appName: this._options.appName
  });

  this._socketServer.on('connection', function (socket) {
    socket.on('message', function () {
      self._ioRequestCount++;
    });
    self.emit(self.EVENT_CONNECTION, socket);
  });
  
  this._socketServer.on('notice', function () {
    self.noticeHandler.apply(self, arguments);
  });

  this._socketURL = this._socketServer.getURL();
  this._socketURLRegex = new RegExp('^' + this._socketURL);

  this._errorDomain.add(this._socketServer);
  this._socketServer.on('ready', function () {
    self._server.on('request', self._httpRequestHandler.bind(self));
    self.emit(self.EVENT_READY);
  });
};

SCWorker.prototype.getSocketURL = function () {
  return this._socketURL;
};

SCWorker.prototype._start = function () {
  this._httpRequestCount = 0;
  this._ioRequestCount = 0;
  this._httpRPM = 0;
  this._ioRPM = 0;

  if (this._statusInterval != null) {
    clearInterval(this._statusInterval);
  }
  this._statusInterval = setInterval(this._calculateStatus.bind(this), this._options.workerStatusInterval * 1000);

  this._server.listen(this._options.workerPort);
};

SCWorker.prototype._httpRequestHandler = function (req, res) {
  this._httpRequestCount++;
  if (req.url == this._paths.statusURL) {
    this._handleStatusRequest(req, res);
  } else if (!this._socketURLRegex.test(req.url)) {
    this._server.emit('req', req, res);
  }
};

SCWorker.prototype._handleStatusRequest = function (req, res) {
  var self = this;

  var isOpen = true;

  var reqTimeout = setTimeout(function () {
    if (isOpen) {
      res.writeHead(500, {
        'Content-Type': 'application/json'
      });
      res.end();
      isOpen = false;
    }
  }, this._options.connectTimeout * 1000);

  var buffers = [];
  req.on('data', function (chunk) {
    buffers.push(chunk);
  });

  req.on('end', function () {
    clearTimeout(reqTimeout);
    if (isOpen) {
      var statusReq = null;
      try {
        statusReq = JSON.parse(Buffer.concat(buffers).toString());
      } catch (e) {}

      if (statusReq && statusReq.dataKey == self._options.dataKey) {
        var status = JSON.stringify(self.getStatus());
        res.writeHead(200, {
          'Content-Type': 'application/json'
        });
        res.end(status);
      } else {
        res.writeHead(401, {
          'Content-Type': 'application/json'
        });
        res.end();
      }
      isOpen = false;
    }
  });
};

SCWorker.prototype.getSCServer = function () {
  return this._socketServer;
};

SCWorker.prototype.getHTTPServer = function () {
  return this._server;
};

SCWorker.prototype._calculateStatus = function () {
  var perMinuteFactor = 60 / this._options.workerStatusInterval;
  this._httpRPM = this._httpRequestCount * perMinuteFactor;
  this._ioRPM = this._ioRequestCount * perMinuteFactor;
  this._httpRequestCount = 0;
  this._ioRequestCount = 0;
};

SCWorker.prototype.getStatus = function () {
  return {
    clientCount: this._socketServer.clientsCount,
    httpRPM: this._httpRPM,
    ioRPM: this._ioRPM
  };
};

SCWorker.prototype.handleMasterEvent = function () {
  this.emit.apply(this, arguments);
};

SCWorker.prototype.errorHandler = function (err) {
  this.emit(self.EVENT_ERROR, err);
};

SCWorker.prototype.noticeHandler = function (notice) {
  if (notice.message != null) {
    notice = notice.message;
  }
  this.emit(this.EVENT_NOTICE, notice);
};

module.exports = SCWorker;