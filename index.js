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
  }

  // login to the site, doing so once every LOGIN_FREQUENCY millis
  async auth() {
    if (Date.now() - this.lastLogin > LOGIN_FREQUENCY) {
      this.log('api', 'logging in...');
      await this.session.post(
        {uri: 'https://mymodlet.com/Account/Login',
          form: {'loginForm.Email': this.username,
            'loginForm.Password': this.password,
            'loginForm.RememberMe': 'True',
            'ReturnUrl': '/smartac'},
          followRedirect: false,
          simple: false});
      this.lastLogin = Date.now();
    }
  }

  // return an iterable of all of the Thermostats in the account
  // will retain a reference to and update the current status of
  // all returned Thermostats each time it's called
  async getThermostats() {
    if (Date.now() - this.lastUpdate > UPDATE_FREQUENCY) {
      this.log('api', 'updating thermostat status...');
      await this.auth();
      const statusTxt =
       await this.session.post('https://mymodlet.com/SmartAC/UserSettingsTable');

      // status is a quoted blob of HTML...
      const status = JSON.parse('{"response":' + statusTxt + '}');
      const $ = cheerio.load(status.response);
      $('#appName').has('.drSetTemp').each((i, e) => {
        const id = $('.drSetTemp', e).attr('id');
        let thermostat = this.thermostats.get(id);
        if (!thermostat) {
          thermostat = new Thermostat(this, id);
          this.thermostats.set(id, thermostat);
        }
        thermostat.name = $(e).children().first().text();
        thermostat.targetTemp = parseInt($('option:checked', $(e).parent()).val());
        thermostat.currentTemp = parseInt($('#currentTemperature', $(e).parent()).text());
        thermostat.powerOn = $('#deviceAction', $(e).parent()).children('a').is('.Off');
      });
      this.lastUpdate = Date.now();
    }
    return this.thermostats.values();
  }

  // push an update for the given thermostat (e.g., new temp and/or on/off)
  // returns a boolean indicating if mymodlet.com told us if it was successful
  async pushUpdate(thermostat) {
    await this.auth();
    const r = await this.session.post(
      {uri: 'https://mymodlet.com/SmartAC/UserSettings',
        body: {'applianceId': thermostat.id,
          'targetTemperature': '' + thermostat.targetTemp,
          'thermostated': thermostat.powerOn },
        json: true });
    return r.Success;
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

  getCurrentHeatingCoolingState(callback) {
    this.api.getThermostats().then(() => {
      this.api.log(this.name, 'heating / cooling state: ' + this.powerOn);
      if (this.powerOn)
        callback(null, Characteristic.CurrentHeatingCoolingState.COOL);
      else
        callback(null, Characteristic.CurrentHeatingCoolingState.OFF);
    });
  }

  setTargetHeatingCoolingState(value, callback) {
    this.api.log(this.name, 'target heating / cooling state: ' + value);
    this.powerOn = value === Characteristic.CurrentHeatingCoolingState.COOL;
    this.update().then(() => callback(null, value));
  }

  getCurrentTemperature(callback) {
    this.api.log(this.name, 'current temp: ' + this.currentTemp);
    this.api.getThermostats().then(() => callback(null, toC(this.currentTemp)));
  }

  getTargetTemperature(callback) {
    this.api.log(this.name, 'get target temp: ' + this.targetTemp);
    this.api.getThermostats().then(() => callback(null, toC(this.targetTemp)));
  }

  setTargetTemperature(value, callback) {
    const targetInF = toF(value);
    this.api.log(this.name, 'set target temp: ' + targetInF + ' / ' + value);
    this.targetTemp = targetInF;
    this.update().then(() => callback(null, value));
  }

  getTemperatureDisplayUnits(callback) {
    this.api.log(this.name, 'temperature display units');
    callback(null, Characteristic.TemperatureDisplayUnits.FAHRENHEIT);
  }

  // homebridge calls this function to learn about the thermostat
  getServices() {
    let thermostatService = new Service.Thermostat(this.name);

    thermostatService
      .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .on('get', this.getCurrentHeatingCoolingState.bind(this));

    thermostatService
      .getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .on('get', this.getCurrentHeatingCoolingState.bind(this))
      .on('set', this.setTargetHeatingCoolingState.bind(this));

    // the next two characteristics work in celsius in the homekit api
    // min/max controls what the ios home app shows for the range of control
    thermostatService
      .getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({ minValue: 5, maxValue: 40, minStep: 0.1})
      .on('get', this.getCurrentTemperature.bind(this));

    thermostatService
      .getCharacteristic(Characteristic.TargetTemperature)
      .setProps({ minValue: 15, maxValue: 33, minStep: 0.1})
      .on('get', this.getTargetTemperature.bind(this))
      .on('set', this.setTargetTemperature.bind(this));

    thermostatService
      .getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .on('get', this.getTemperatureDisplayUnits.bind(this));

    let informationService = new Service.AccessoryInformation()
      .setCharacteristic(Characteristic.Manufacturer, 'ThinkEco')
      .setCharacteristic(Characteristic.Model, 'SmartAC')
      .setCharacteristic(Characteristic.SerialNumber, 'Not Applicable');

    return [informationService, thermostatService];
  }
}
