const dotenv = require('dotenv').config();
if (dotenv.error) { throw dotenv.error; }

const debug = require('debug');
const dbgServer = debug('server');
const dbgSocket = debug('socket');
const dbgCluster = debug('cluster');

const cluster = require('cluster');
const sticky = require('sticky-session');
const socketio = require('socket.io');
const express = require('express');
const net = require('net');
const ioRedis = require('socket.io-redis');
const farmhash = require('farmhash');

const num_processes = require('os').cpus().length;

// https://github.com/elad/node-cluster-socket.io
// https://github.com/indutny/sticky-session
if (cluster.isMaster) {
  // This stores our workers, based on source IP address.
  const workers = [];

  // Helper function for spawning worker at index 'i'.
  const spawn = i => {
    workers[i] = cluster.fork();

    // Optional: Restart worker on exit
    workers[i].on('exit', (code, signal) => {
      dbgCluster('respawning worker', i);
      spawn(i);
    });
  }

  // Spawn workers.
  [...Array(num_processes).keys()].forEach(i => spawn(i));

  // Helper function for getting a worker index based on IP address.
  // This is a hot path so it should be really fast. The way it works
  // is by converting the IP address to a number by removing non numeric
  // characters, then compressing it to the number of slots we have.
  //
  // Compared against "real" hashing (from the sticky-session code) and
  // "real" IP number conversion, this function is on par in terms of
  // worker index distribution only much faster.
  // Farmhash is the fastest and works with IPv6, too
  const worker_index = (ip, len) => farmhash.fingerprint32(ip) % len;

  // Create the outside facing server listening on our port.
  const server = net.createServer({ pauseOnConnect: true }, connection => {
    // We received a connection and need to pass it to the appropriate worker. 
    // Get the worker for this connection's source IP and pass it the connection.
    const worker = workers[worker_index(connection.remoteAddress, num_processes)];
    worker.send('sticky-session:connection', connection);
  }).listen(process.env.PORT);
  dbgServer(server._connectionKey, 'listening on', process.env.PORT);

} else {
  // Note we don't use a port here because the master listens on it for us.

  const app = new express();

  // Here you might use middleware, attach routes, etc.
  app.use(express.static('public'));
  app.get('/', (req, res) => res.sendFile(__dirname + '/public/index.html'));

  // Don't expose our internal server to the outside.
  const server = app.listen(0, 'localhost');
  const io = socketio(server);

  // Tell Socket.IO to use the redis adapter. By default, the redis
  // server is assumed to be on localhost:6379. You don't have to
  // specify them explicitly unless you want to change them.
  io.adapter(ioRedis({ host: process.env.REDIS_HOST, port: process.env.REDIS_PORT }));

  // Here you might use Socket.IO middleware for authorization etc.
  io.on('connection', socket => {
    dbgSocket(socket.id, 'connected');
    socket.emit('welcome', { hello: 'world' });
    socket.on('hello', data => dbgSocket(socket.id, 'event: hello', data));
    socket.on('disconnect', () => dbgSocket(socket.id, 'disconnected'));
    setTimeout(() => socket.emit('welcome', { hello: '2000' }), 2000);
    setTimeout(() => socket.disconnect(true), 4000);
  });

  // Listen to messages sent from the master. Ignore everything else.
  process.on('message', (message, connection) => {
    if (message !== 'sticky-session:connection') {
      return;
    }

    // Emulate a connection event on the server by emitting the
    // event with the connection the master sent us.
    server.emit('connection', connection);

    connection.resume();
  });
}
