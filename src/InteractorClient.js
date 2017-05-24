/**
 * Copyright Keymetrics Team. All rights reserved.
 * Use of this source code is governed by a license that
 * can be found in the LICENSE file.
 */

'use strict';

const log = require('debug')('pm2:interface:daemon');
const fs = require('fs');
const path = require('path');
const rpc = require('pm2-axon-rpc');
const axon = require('pm2-axon');
const chalk = require('chalk');
const os = require('os');
const Common = require('pm2/lib/Common');
const UX = require('pm2/lib/API/CliUx.js');

const InteractorDaemonizer = module.exports = {};

InteractorDaemonizer.rpc = {};

/**
 * Ping the Interactor to see if its online
 * @param {Object} opts global constants
 * @param {String} opts.INTERACTOR_RPC_PORT path used to connect to the interactor
 * @param {Function} cb invoked with <err, result>
 */
InteractorDaemonizer.ping = function (opts, cb) {
  if (typeof cb !== 'function') {
    throw new Error('Missing parameters');
  } else if (typeof opts !== 'object' || !opts || !opts.INTERACTOR_RPC_PORT) {
    return cb(new Error('Missing parameters'));
  }
  var req = axon.socket('req');
  var client = new rpc.Client(req);

  log('[PING INTERACTOR] Trying to connect to Interactor daemon');

  client.sock.once('reconnect attempt', function () {
    client.sock.close();
    log('Interactor Daemon not launched');
    return cb(null, false);
  });

  client.sock.once('connect', function () {
    client.sock.once('close', function () {
      return cb(null, true);
    });
    client.sock.close();
    log('Interactor Daemon alive');
  });

  req.connect(opts.INTERACTOR_RPC_PORT);
};

/**
 * Try to kill the interactor daemon via RPC
 * @param {Object} conf global constants
 * @param {String} conf.INTERACTOR_RPC_PORT path used to connect to the interactor
 * @param {Function} cb invoked with <err>
 */
InteractorDaemonizer.killInteractorDaemon = function (conf, cb) {
  process.env.PM2_INTERACTOR_PROCESSING = true;

  log('Killing interactor #1 ping');
  InteractorDaemonizer.ping(conf, function (err, online) {
    log(`Interactor is ${!online || err ? 'offline' : 'online'}`);

    if (!online || err) {
      return cb ? err ? cb(err) : cb(new Error('Interactor not launched')) : Common.printError('Interactor not launched');
    }

    InteractorDaemonizer.launchRPC(conf, function (err, data) {
      if (err) {
        setTimeout(function () {
          InteractorDaemonizer.disconnectRPC(cb);
        }, 100);
        return false;
      }
      InteractorDaemonizer.rpc.kill(function (err) {
        if (err) Common.printError(err);
        setTimeout(function () {
          InteractorDaemonizer.disconnectRPC(cb);
        }, 100);
      });
      return false;
    });
    return false;
  });
};

/**
 * Start a RPC client that connect to the InteractorDaemon
 * @param {Object} conf global constants
 * @param {Function} cb invoked with <err>
 */
InteractorDaemonizer.launchRPC = function (conf, cb) {
  var self = this;
  var req = axon.socket('req');
  this.client = new rpc.Client(req);

  log('Generating Interactor methods of RPC client');

  // attach known methods to RPC client
  var generateMethods = function (cb) {
    self.client.methods(function (err, methods) {
      if (err) return cb(err);
      Object.keys(methods).forEach(function (key) {
        var method = methods[key];
        log('+ Adding %s method to interactor RPC client', method.name);
        (function (name) {
          self.rpc[name] = function () {
            var args = Array.prototype.slice.call(arguments);
            args.unshift(name);
            self.client.call.apply(self.client, args);
          };
        })(method.name);
      });
      return cb();
    });
  };

  this.client.sock.once('reconnect attempt', function (err) {
    self.client.sock.removeAllListeners();
    return cb(err, { success: false, msg: 'reconnect attempt' });
  });

  this.client.sock.once('error', function (err) {
    console.error('-- Error in error catch all on Interactor --');
    console.error(err);
  });

  this.client.sock.once('connect', function () {
    self.client.sock.removeAllListeners();
    generateMethods(function () {
      log('Methods of RPC client for Interaction ready.');
      return cb(null, { success: true });
    });
  });

  this.client_sock = req.connect(conf.INTERACTOR_RPC_PORT);
};

/**
 * Start or Restart the Interaction Daemon depending if its online or not
 * @private
 * @param {Object} conf global constants
 * @param {Object} infos data used to start the interactor [can be recovered from FS]
 * @param {String} infos.secret_key the secret key used to cipher data
 * @param {String} infos.public_key the public key used identify the user
 * @param {String} infos.machine_name [optional] override name of the machine
 * @param {Function} cb invoked with <err, msg, process>
 */
const daemonize = function (conf, infos, cb) {
  var InteractorJS = path.resolve(path.dirname(module.filename), 'InteractorDaemon.js');

  // Redirect PM2 internal err and out
  // to STDERR STDOUT when running with Travis
  var testEnv = process.env.TRAVIS || (process.env.NODE_ENV && process.env.NODE_ENV.match(/test/));
  var out = testEnv ? 1 : fs.openSync(conf.INTERACTOR_LOG_FILE_PATH, 'a');
  var err = testEnv ? 2 : fs.openSync(conf.INTERACTOR_LOG_FILE_PATH, 'a');

  var child = require('child_process').spawn('node', [InteractorJS], {
    silent: false,
    detached: true,
    cwd: process.cwd(),
    env: Object.assign({
      PM2_HOME: conf.PM2_HOME,
      PM2_MACHINE_NAME: infos.machine_name,
      PM2_SECRET_KEY: infos.secret_key,
      PM2_PUBLIC_KEY: infos.public_key,
      PM2_REVERSE_INTERACT: infos.reverse_interact,
      KEYMETRICS_NODE: infos.info_node
    }, process.env),
    stdio: ['ipc', out, err]
  });

  UX.processing.start();

  fs.writeFileSync(conf.INTERACTOR_PID_PATH, child.pid);

  child.once('error', function (err) {
    log('Error when launching Interactor, please check the agent logs');
    return cb(err);
  });

  child.unref();

  child.once('message', function (msg) {
    log('Interactor daemon launched : %s', msg);

    UX.processing.stop();

    if (msg.log) {
      return cb(null, msg, child);
    }

    child.removeAllListeners('error');
    child.disconnect();

    // Handle and show to user the different error message that can happen
    if (msg.error === true) {
      console.log(chalk.red('[Keymetrics.io][ERROR]'), msg.msg);
      console.log(chalk.cyan('[Keymetrics.io]') + ' Contact support contact@keymetrics.io and send us the error message');
      return cb(msg);
    } else if (msg.km_data && msg.km_data.disabled === true) {
      console.log(chalk.cyan('[Keymetrics.io]') + ' Server DISABLED BY ADMINISTRATION contact support contact@keymetrics.io with reference to your public and secret keys)');
      return cb(msg);
    } else if (msg.km_data && msg.km_data.error === true) {
      console.log('%s %s (Public: %s) (Secret: %s) (Machine name: %s)', chalk.red('[Keymetrics.io][ERROR]'),
                      msg.km_data.msg, msg.public_key, msg.secret_key, msg.machine_name);
      return cb(msg);
    } else if (msg.km_data && msg.km_data.active === false && msg.km_data.pending === true) {
      console.log('%s %s - Web Access: https://app.keymetrics.io/', chalk.red('[Keymetrics.io]'), chalk.bold.red('Agent PENDING'));
      console.log('%s You must upgrade your bucket in order to monitor more servers.', chalk.red('[Keymetrics.io]'));
      return cb(msg);
    }

    if (msg.km_data && msg.km_data.active === true) {
      console.log('%s [%s] Agent ACTIVE - Web Access: https://app.keymetrics.io/', chalk.cyan('[Keymetrics.io]'), msg.km_data.new ? 'Agent created' : 'Agent updated');
    }
    return cb(null, msg, child);
  });
};

/**
 * Start or Restart the Interaction Daemon depending if its online or not
 * @private
 * @param {Object} conf global constants
 * @param {Object} infos data used to start the interactor [can be recovered from FS]
 * @param {String} infos.secret_key the secret key used to cipher data
 * @param {String} infos.public_key the public key used identify the user
 * @param {String} infos.machine_name [optional] override name of the machine
 * @param {Function} cb invoked with <err, msg, process>
 */
function launchOrAttach (conf, infos, cb) {
  InteractorDaemonizer.ping(conf, function (online) {
    if (online) {
      log('Interactor online, restarting it...');
      InteractorDaemonizer.launchRPC(conf, function () {
        InteractorDaemonizer.rpc.kill(function (ignoredErr) {
          daemonize(conf, infos, cb);
        });
      });
    } else {
      log('Interactor offline, launching it...');
      daemonize(conf, infos, cb);
    }
  });
}

/**
 * Restart the Interactor Daemon
 * @param {Object} conf global constants
 * @param {Function} cb invoked with <err, msg>
 */
InteractorDaemonizer.update = function (conf, cb) {
  InteractorDaemonizer.ping(conf, function (online) {
    if (!online) {
      return cb ? cb(new Error('Interactor not launched')) : Common.printError('Interactor not launched');
    }
    InteractorDaemonizer.launchRPC(conf, function () {
      InteractorDaemonizer.rpc.kill(function (err) {
        if (err) {
          return cb ? cb(err) : Common.printError(err);
        }
        Common.printOut('Interactor successfully killed');
        setTimeout(function () {
          InteractorDaemonizer.launchAndInteract(conf, {}, function () {
            return cb(null, { msg: 'Daemon launched' });
          });
        }, 500);
      });
    });
  });
};

/**
 * Retrieve Interactor configuration from env, params and filesystem.
 * @param {Object} cst global constants
 * @param {Object} infos data used to start the interactor [optional]
 * @param {String} infos.secret_key the secret key used to cipher data [optional]
 * @param {String} infos.public_key the public key used identify the user [optional]
 * @param {String} infos.machine_name override name of the machine [optional]
 * @param {Function} cb invoked with <err, configuration>
 */
InteractorDaemonizer.getOrSetConf = function (cst, infos, cb) {
  infos = infos || {};
  var configuration = {
    version_management: {
      active: true,
      password: null
    }
  };
  var confFS = {};

  // Try loading configuration file on FS
  try {
    confFS = JSON.parse(fs.readFileSync(cst.INTERACTION_CONF));

    if (confFS.version_management) {
      configuration.version_management_password = confFS.version_management.password;
      configuration.version_management_active = confFS.version_management.active;
    }
  } catch (e) {
    log('Interaction file does not exists');
  }

  // load the configration (first have priority)
  //    -> from env variable
  //    -> from params (eg. CLI)
  //    -> from configuration on FS
  configuration.public_key = process.env.PM2_PUBLIC_KEY || process.env.KEYMETRICS_PUBLIC || infos.public_key || confFS.public_key;
  configuration.secret_key = process.env.PM2_SECRET_KEY || process.env.KEYMETRICS_SECRET || infos.secret_key || confFS.secret_key;
  configuration.machine_name = infos.machine_name || confFS.machine_name || os.hostname();
  configuration.reverse_interact = confFS.reverse_interact || true;
  // is setup empty ? use the one provided in env OR root OTHERWISE get the one on FS conf OR fallback on root
  configuration.info_node = process.env.KEYMETRICS_NODE || infos.info_node || confFS.info_node || cst.KEYMETRICS_ROOT_URL;
  if (!configuration.secret_key) return cb(new Error('secret key is not defined'));

  if (!configuration.public_key) return cb(new Error('public key is not defined'));

  // write configuration on FS
  try {
    fs.writeFileSync(cst.INTERACTION_CONF, JSON.stringify(configuration, null, 4));
  } catch (e) {
    console.error('Error when writting configuration file %s', cst.INTERACTION_CONF);
    return cb(e);
  }

  // Don't block the event loop
  process.nextTick(function () {
    return cb(null, configuration);
  });
};

/**
 * Disconnect the RPC client from Interactor Daemon
 * @param {Function} cb invoked with <err, msg>
 */
InteractorDaemonizer.disconnectRPC = function (cb) {
  if (!InteractorDaemonizer.client_sock || !InteractorDaemonizer.client_sock.close) {
    return cb(null, {
      success: false,
      msg: 'RPC connection to Interactor Daemon is not launched'
    });
  }

  if (InteractorDaemonizer.client_sock.connected === false || InteractorDaemonizer.client_sock.closing === true) {
    return cb(null, {
      success: false,
      msg: 'RPC closed'
    });
  }

  try {
    var timer;

    log('Closing RPC INTERACTOR');

    InteractorDaemonizer.client_sock.once('close', function () {
      log('RPC INTERACTOR cleanly closed');
      clearTimeout(timer);
      return cb ? cb(null, { success: true }) : false;
    });

    timer = setTimeout(function () {
      if (InteractorDaemonizer.client_sock.destroy) {
        InteractorDaemonizer.client_sock.destroy();
      }
      return cb ? cb(null, { success: true }) : false;
    }, 200);

    InteractorDaemonizer.client_sock.close();
  } catch (err) {
    log('Error while closing RPC INTERACTOR : %s', err.message || err);
    return cb ? cb(err) : false;
  }
};

/**
 * Start the Interactor Daemon
 * @param {Object} cst global constants
 * @param {Object} infos data used to start the interactor [can be recovered from FS]
 * @param {String} infos.secret_key the secret key used to cipher data
 * @param {String} infos.public_key the public key used identify the user
 * @param {String} infos.machine_name [optional] override name of the machine
 * @param {Function} cb invoked with <err, msg, process>
 */
InteractorDaemonizer.launchAndInteract = function (cst, opts, cb) {
  // For Watchdog
  if (process.env.PM2_AGENT_ONLINE) {
    return process.nextTick(cb);
  }

  process.env.PM2_INTERACTOR_PROCESSING = true;

  InteractorDaemonizer.getOrSetConf(cst, opts, function (err, conf) {
    if (err || !conf) return cb(err || new Error('Cant retrieve configuration'));

    console.log(chalk.cyan('[Keymetrics.io]') + ' Using (Public key: %s) (Private key: %s)', conf.public_key, conf.secret_key);
    return launchOrAttach(cst, conf, cb);
  });
};

/**
 * Retrieve configuration used by the Interaction Daemon
 * @param {Object} cst global constants
 * @param {Function} cb invoked with <err, data>
 */
InteractorDaemonizer.getInteractInfo = function (cst, cb) {
  log('Getting interaction info');
  if (process.env.PM2_NO_INTERACTION) return;

  InteractorDaemonizer.ping(cst, function (online) {
    if (!online) return cb(new Error('Interactor is offline'));

    InteractorDaemonizer.launchRPC(cst, function () {
      InteractorDaemonizer.rpc.getInfos(function (err, infos) {
        if (err) return cb(err);

        // Avoid general CLI to interfere with Keymetrics CLI commands
        if (process.env.PM2_INTERACTOR_PROCESSING) return cb(null, infos);

        InteractorDaemonizer.disconnectRPC(function () {
          return cb(null, infos);
        });
      });
    });
  });
};