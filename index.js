const cheerio = require('cheerio');
const rp = require('request-promise-native');

var Service;
var Characteristic;

module.exports = function(homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  homebridge.registerPlatform('homebridge-platform-smartac', 'SmartAC', SmartACPlatform);
};

function SmartACPlatform(log, config) {
  this.log = log;
  this.config = config;
}

SmartACPlatform.prototype.accessories = function(callback) {
  new ThinkEcoAPI(this.config['username'], this.config['password'], this.log)
    .getThermostats()
    .then(thermostats => callback(Array.from(thermostats)));
};

const LOGIN_FREQUENCY = 2 * 60 * 60 * 1000; // 2 hours
const UPDATE_FREQUENCY = 2 * 1000; // 2 seconds

// this is a very simple mutex that we use to ensure
// that we make only one concurrent request goes to mymodlet.com
class Lock {
  constructor() {
    this.locked = false;
    this.waiters = [];
  }

  // returns a promise that resolves when the lock is acquired
  acquire() {
    if (this.locked) {
      let notify;
      // the notify() method on the promise object will now
      // resolve that promise. once resolved, it will attempt
      // to reacquire the lock
      const p = new Promise(resolve => notify = resolve)
        .then(() => this.acquire());

      p.notify = notify;
      this.waiters.push(p);
      return p;
    }
    else {
      // if we can acquire the lock straight away, just
      // return an already resolved promise
      this.locked = true;
      return Promise.resolve(true);
    }
  }

  release() {
    this.locked = false;
    const next = this.waiters.shift();
    if (next)
      next.notify(true);
  }
}


// encapsulate the ThinkEco "API" / screen scraping mymodlet.com
// handles retrieving and updating thermostat statuses and maintains
// a cache of all known thermostats in the mymodlet.com account
class ThinkEcoAPI {
  constructor(username, password, log) {
    this.username = username;
    this.password = password;
    this.lastLogin = new Date(1970, 1, 1);
    this.lastUpdate = new Date(1970, 1, 1);
    this.thermostats = new Map();
    this.session = rp.defaults({ gzip:true, jar:true });
    this.log = log;
    this.lock = new Lock();
  }

  // login to the site, doing so once every LOGIN_FREQUENCY millis
  async auth() {
    if (Date.now() - this.lastLogin > LOGIN_FREQUENCY) {
      this.log('api', 'logging in...');

      await this.session.post({
        uri: 'https://web.mymodlet.com/Account/Login',
        body: {
          // ThinkEco uses a strangely formatted payload:
          // stringified JSON inside a 'data' JSON object.
          data: JSON.stringify({
            'Email': this.username,
            'Password': this.password,
          }),
        },
        followRedirect: false,
        simple: false,
        json: true,
        jar: true,
      });

      this.lastLogin = Date.now();
    }
  }

  // return an iterable of all of the Thermostats in the account
  // will retain a reference to and update the current status of
  // all returned Thermostats each time it's called
  async getThermostats() {
    // we only want a single concurrent call to mymodlet.com
    // because this is quite expensive. without a lock, multiple
    // concurrent operations here makes updating multiple attributes
    // on a thermostat(s) is pretty slow.
    await this.lock.acquire();
    if (Date.now() - this.lastUpdate > UPDATE_FREQUENCY) {
      this.log('api', 'updating thermostat status...');
      await this.auth();
      const statusTxt =
        await this.session.get('https://web.mymodlet.com/Devices/UpdateData');

      // statusTxt is a quoted string of JSON, e.g. "{\"SmartACs\": ... }" 
      let status = JSON.parse(JSON.parse(statusTxt));
      status.SmartACs.forEach(ac => {
        // Find the corresponding device for name.
        const modletId = ac.modlet.modletId;
        const device = status.Devices.find(item => item.modletId == modletId);
        const id = device.deviceId;

        let thermostat = this.thermostats.get(id);
        if (!thermostat) {
          thermostat = new Thermostat(this, id);
          this.thermostats.set(id, thermostat);
        }

        thermostat.name = device.deviceName;
        thermostat.targetTemp = ac.thermostat.targetTemperature;
        thermostat.currentTemp = ac.thermostat.currentTemperature;
        thermostat.powerOn = ac.modlet.isOn;
        thermostat.modletOffline = ! ac.modlet.isOTA;
        thermostat.thermostatOffline = !(ac.modlet.hasThermostat && ac.thermostat.thermostatIsOTA);
      });

      this.lastUpdate = Date.now();
    }
    this.lock.release();
    return this.thermostats.values();
  }

  // push an update for the given thermostat (e.g., new temp and/or on/off)
  // returns a boolean indicating if mymodlet.com told us if it was successful
  async pushUpdate(thermostat) {
    await this.auth();
    const r = await this.session.post({
      uri: 'https://web.mymodlet.com/Devices/UserSettingsUpdate',
      body: {
        data: JSON.stringify({
          'DeviceId': thermostat.id,
          'TargetTemperature': String(thermostat.targetTemp),
          'IsThermostated': thermostat.powerOn
        }),
      },
      json: true
    });

    // Returned as a quoted string of JSON, so need to decode again...
    const parsedResponse = JSON.parse(r);

    return parsedResponse.data.status.IsError === false;
  }
}

function toC(fahrenheit) {
  return (fahrenheit - 32) * .5556;
}

function toF(celsius) {
  return Math.round(celsius / .5556 + 32);
}

class Thermostat {
  constructor(api, id) {
    this.api = api;
    this.id = id;
  }

  async update() {
    return this.api.pushUpdate(this);
  }

  getActiveState(callback) {
    (async () => {
      await this.api.getThermostats();

      if (this.modletOffline) {
        return callback(new Error('Modlet broken.'));
      }

      this.api.log(this.name, 'heating / cooling active: ' + this.powerOn);

      callback(null, this.powerOn ?
        Characteristic.Active.ACTIVE:
        Characteristic.Active.INACTIVE);
    })();
  }

  setActiveState(value, callback) {
    (async () => {
      await this.api.getThermostats();

      if (this.modletOffline) {
        return callback(new Error('Modlet broken.'));
      }

      this.api.log(this.name, 'set heating / cooling active: ' + !this.powerOn);

      this.powerOn = !this.powerOn;
      this.update().then(() => callback());
    })();
  }

  getCurrentHeaterCoolerState(callback) {
    (async () => {
      await this.api.getThermostats();

      // Check if we're at our target temperature, so we can show
      // the air conditioner as "idle" in the Home app.
      var atTarget = toC(this.currentTemp) <= toC(this.targetTemp);

      this.api.log(this.name, 'heating / cooling state: ' + atTarget);

      callback(null, atTarget ?
        Characteristic.CurrentHeaterCoolerState.IDLE:
        Characteristic.CurrentHeaterCoolerState.COOLING);
    })();
  }

  getTargetHeaterCoolerState(callback) {
    callback(null, Characteristic.TargetHeaterCoolerState.COOL);
  }

  getCurrentTemperature(callback) {
    (async () => {
      await this.api.getThermostats();

      if (this.thermostatOffline) {
        // Passing an actual error here disables HomeKit controls,
        // so using '0° F' to indicate thermostat offline.
        return callback(null, toC(0));
      }

      this.api.log(this.name, 'current temp: ' + this.currentTemp);
      callback(null, toC(this.currentTemp));
    })();
  }

  getTargetTemperature(callback) {
    (async () => {
      await this.api.getThermostats();

      if (this.modletOffline) {
        return callback(new Error('Modlet broken.'));
      }

      this.api.log(this.name, 'get target temp: ' + this.targetTemp);
      callback(null, toC(this.targetTemp));
    })();
  }

  setTargetTemperature(value, callback) {
    const targetInF = toF(value);
    this.api.log(this.name, 'set target temp: ' + targetInF + ' / ' + value);
    this.targetTemp = targetInF;
    this.update().then(() => callback(null, value));
  }

  // homebridge calls this function to learn about the thermostat
  getServices() {
    const heaterCoolerService = new Service.HeaterCooler(this.name);

    heaterCoolerService
      .getCharacteristic(Characteristic.Active)
      .on('get', this.getActiveState.bind(this))
      .on('set', this.setActiveState.bind(this));

    heaterCoolerService
      .getCharacteristic(Characteristic.CurrentHeaterCoolerState)
      .on('get', this.getCurrentHeaterCoolerState.bind(this));

    heaterCoolerService
      .getCharacteristic(Characteristic.TargetHeaterCoolerState)
      .setProps({
        // Only show options for cooling, since it's an A/C!
        validValues: [Characteristic.TargetHeaterCoolerState.COOL]
      })
      .on('get', this.getTargetHeaterCoolerState.bind(this));

    // the next two characteristics work in celsius in the homekit api
    // min/max controls what the ios home app shows for the range of control
    heaterCoolerService
      .getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({ minValue: -100, maxValue: 100, minStep: 0.1})
      .on('get', this.getCurrentTemperature.bind(this));

    heaterCoolerService
      .getCharacteristic(Characteristic.CoolingThresholdTemperature)
      .setProps({ minValue: 15, maxValue: 33, minStep: 0.1})
      .on('get', this.getTargetTemperature.bind(this))
      .on('set', this.setTargetTemperature.bind(this));

    const informationService = new Service.AccessoryInformation()
      .setCharacteristic(Characteristic.Manufacturer, 'ThinkEco')
      .setCharacteristic(Characteristic.Model, 'SmartAC')
      .setCharacteristic(Characteristic.SerialNumber, 'Not Applicable');

    return [informationService, heaterCoolerService];
  }
}
