'use strict';

const async = require('async');
const Device = require('./accessory.js');
const version = require('../package.json').version;
const LogUtil = require('../lib/LogUtil.js');

var HomebridgeAPI, FakeGatoHistoryService;

const pluginName = 'homebridge-tado-platform';
const platformName = 'TadoPlatform';

module.exports = function (homebridge) {
  HomebridgeAPI = homebridge;
  FakeGatoHistoryService = require('fakegato-history')(homebridge);
  return TadoPlatform;
};

function TadoPlatform (log, config, api) {
  if (!api || !config) return;
  if (!config.username || !config.password) throw new Error('Please check your config.json!');
  
  log('Homebridge TadoPlatform v' + version + ' loaded');

  // HB
  const self = this;
  this.log = log;
  this.logger = new LogUtil(null, log);
  this.accessories = [];
  this.HBpath = api.user.storagePath()+'/accessories';
  
  this.config = {
    name: config.name||'Tado',
    username: encodeURIComponent(config.username),
    password: encodeURIComponent(config.password),
    polling: (config.polling*1000)||10000,
    url: 'https://my.tado.com/api/v2/',
    centralSwitch: config.centralSwitch===true,
    occupancy: config.occupancy||false,
    weather: config.weather===true,
    radiatorThermostat: config.radiatorThermostat===true,
    boilerThermostat: config.boilerThermostat||false,
    remoteThermostat: config.remoteThermostat||false,
    onePerRoom: config.onePerRoom||false,
    externalSensor: config.externalSensor||false,
    openWindow: config.openWindow||false,
    extendedWeatherActive: config.extendedWeather.activate||false,
    extendedWeatherKey: config.extendedWeather.key||undefined,
    extendedWeatherLocation: config.extendedWeather.location||undefined,
    extendedDelay: config.extendedDelay||false,
    solarIntensity: config.solarIntensity||false
  };
  
  this.config.polling < 10000 ? this.config.polling = 10000 : this.config.polling;

  // STORAGE
  this.storage = require('node-persist');
  this.storage.initSync({
    dir: HomebridgeAPI.user.persistPath()
  });
  
  this.types = {
    radiatorThermostat: 1,
    central: 2,
    occupancy: 3,
    weather: 4,
    boilerThermostat: 5,
    remoteThermostat: 6,
    externalSensor: 7,
    onePerRoom: 8,
    windowSensor: 9,
    solar: 10
  };
  
  this.error = {
    thermostats: 0,
    central: 0,
    occupancy: 0
  };

  // Init req promise
  this.getContent = function(url) {
    return new Promise((resolve, reject) => {
      const lib = url.startsWith('https') ? require('https') : require('http');
      const request = lib.get(url, (response) => {
        if (response.statusCode < 200 || response.statusCode > 299) {
          reject(new Error('Failed to load data, status code: ' + response.statusCode));
        }
        const body = [];
        response.on('data', (chunk) => body.push(chunk));
        response.on('end', () => resolve(body.join('')));
      });
      request.on('error', (err) => reject(err));
    });
  };
  
  if (api) {
    if (api.version < 2.2) {
      throw new Error('Unexpected API version. Please update your homebridge!');
    }
    self.logger.info('**************************************************************');
    self.logger.info('                                  TadoPlatform v'+version+' by SeydX');
    self.logger.info('     GitHub: https://github.com/SeydX/homebridge-tado-platform');
    self.logger.info('                                      Email: seyd55@outlook.de');
    self.logger.info('**************************************************************');
    self.logger.info('start success...');
    this.api = api;
    this.api.on('didFinishLaunching', self.didFinishLaunching.bind(this));
  }
}

TadoPlatform.prototype = {

  didFinishLaunching: function(){
    const self = this;
    self.checkStorage(function (err, state) {
      if(err||!state){
        if(err)self.logger.error(err);
        setTimeout(function(){
          self.didFinishLaunching();
        }, 5000);
      } else {
        self.logger.info('Connecting to API and looking for new devices...');
        self.checkingThermostats(state);
        self.initPlatform(state);
      }
    });  
  },

  checkStorage: function (callback) {
    const self = this;
    if(!self.storage.getItem('Tado_API')){
      self.logger.info('Requesting information from Tado API...');
      const parameter = {};
      async.waterfall([
        function(next) {
          function fetchHomeID(next) {
            self.logger.info('Getting Home ID...');
            self.getContent(self.config.url + 'me?username=' + self.config.username + '&password=' + self.config.password)
              .then((data) => {
                const response = JSON.parse(data);
                parameter['homeID'] = response.homes[0].id;
                next(null, parameter);
              })
              .catch((err) => {
                self.logger.error('An error occured by getting Home ID, trying again...');
                self.logger.error(err);
                setTimeout(function(){
                  fetchHomeID(next);
                }, self.config.polling);
              });
          } fetchHomeID(next);            
        },
        function(parameter, next) {
          function fetchUnit(next){
            self.logger.info('Getting Temperature Unit...');
            self.getContent(self.config.url + 'homes/' + parameter.homeID + '?username=' + self.config.username + '&password=' + self.config.password)
              .then((data) => {
                const response = JSON.parse(data);
                parameter['tempUnit'] = response.temperatureUnit;
                next(null, parameter);
              })
              .catch((err) => {
                self.logger.error('An error occured by getting Temperature Unit, trying again...');
                self.logger.error(err);
                setTimeout(function(){
                  fetchUnit(next);
                }, 30000);
              });
          } fetchUnit(next);
        }
      ], function (err, result) {
        if(err){
          self.logger.error(err);
        } else {
          self.logger.info('Storing Tado_API in cache...');
          self.storage.setItem('Tado_API', result);
          callback(null, result);
        }
      });
    } else {
      callback(null, self.storage.getItem('Tado_API'));
    }
  },
  
  checkingThermostats: function (parameter) {
    const self = this;
    self.getContent(self.config.url + 'homes/' + parameter.homeID + '/zones?username=' + self.config.username + '&password=' + self.config.password)
      .then((data) => {
        const response = JSON.parse(data);
        const thermoArray = [];
        const extraArray = [];
        const windowArray = [];
        const configArray = [];
        if(self.config.radiatorThermostat&&!self.config.onePerRoom){
          configArray.push({
            type: 'HEATING',
            deviceType: 'VA01',
            thermoType: self.types.radiatorThermostat
          });
        }
        if(self.config.boilerThermostat){ 
          configArray.push({
            type: 'HOT_WATER',
            deviceType: 'BU01',
            thermoType: self.types.boilerThermostat
          });
        }
        if(self.config.remoteThermostat&&!self.config.onePerRoom){
          configArray.push({
            type: 'HEATING',
            deviceType: 'RU01',
            thermoType: self.types.radiatorThermostat
          });
        }
        for(const i in response){
          if(response[i].type == 'HEATING'){
            extraArray.push(response[i].id);
            //External Sensors
            if (self.config.externalSensor) {
              let skipSensor = false;
              for (const d in self.accessories) {
                if (self.accessories[d].context.type == self.types.externalSensor) {
                  if (self.accessories[d].context.zoneID == response[i].id) {
                    skipSensor = true;
                  }
                }
              }
              if (!skipSensor) {
                parameter['zoneID'] = response[i].id;
                parameter['room'] = response[i].name;
                parameter['name'] = response[i].name + ' Temperature';
                parameter['shortSerialNo'] = parameter.homeID + '-' + self.types.externalSensor + '-' + response[i].id;
                parameter['type'] = self.types.externalSensor;
                parameter['model'] = 'Temperature';
                parameter['username'] = self.config.username;
                parameter['password'] = self.config.password;
                parameter['url'] = self.config.url;
                parameter['logging'] = true;
                parameter['loggingType'] = 'weather';
                parameter['loggingTimer'] = true;
                new Device(self, parameter, true);  
              }
            }
            //Window Sensors
            if (self.config.openWindow) {
              if(response[i].openWindowDetection.supported&&response[i].openWindowDetection.enabled){
                windowArray.push(response[i].id);
                let skipWindow = false;
                for (const windows in self.accessories) {
                  if (self.accessories[windows].context.type == self.types.windowSensor) {
                    if (self.accessories[windows].context.zoneID == response[i].id) {
                      skipWindow = true;
                    }
                  }
                }
                if (!skipWindow) {
                  parameter['zoneID'] = response[i].id;
                  parameter['room'] = response[i].name;
                  parameter['name'] = response[i].name + ' Window';
                  parameter['shortSerialNo'] = parameter.homeID + '-' + self.types.windowSensor + '-' + response[i].id;
                  parameter['type'] = self.types.windowSensor;
                  parameter['model'] = 'Window';
                  parameter['username'] = self.config.username;
                  parameter['password'] = self.config.password;
                  parameter['url'] = self.config.url;
                  parameter['logging'] = false;
                  new Device(self, parameter, true);  
                }
              }
            }
            //One per room thermostats
            if (self.config.onePerRoom) {
              let skipRoom = false;
              for (const rooms in self.accessories) {
                if (self.accessories[rooms].context.type == self.types.radiatorThermostat && self.accessories[rooms].context.extraType == self.types.onePerRoom) {
                  if (self.accessories[rooms].context.zoneID == response[i].id) {
                    skipRoom = true;
                  }
                }
              }
              if (!skipRoom) {
                parameter['zoneID'] = response[i].id;
                parameter['room'] = response[i].name;
                parameter['name'] = response[i].name + ' Thermostat';
                parameter['batteryState'] = 'NORMAL';
                parameter['shortSerialNo'] = parameter.homeID + '-' + self.types.onePerRoom + '-' + response[i].id;
                parameter['type'] = self.types.radiatorThermostat;
                parameter['extraType'] = self.types.onePerRoom;
                parameter['model'] = 'Thermostat';
                parameter['username'] = self.config.username;
                parameter['password'] = self.config.password;
                parameter['url'] = self.config.url;
                parameter['logging'] = true;
                parameter['loggingType'] = 'weather';
                parameter['loggingTimer'] = true;
                new Device(self, parameter, true);  
              }
            }
          }
          //Radiator, Boiler & Remote Thermostats
          for(const config in configArray){
            if(configArray[config].type == response[i].type){
              for(const j in response[i].devices){
                const devices = response[i].devices;
                if(configArray[config].deviceType == devices[j].deviceType){
                  thermoArray.push(devices[j].shortSerialNo);
                  let skipThermo = false;
                  for(const l in self.accessories){
                    if(configArray[config].thermoType == self.accessories[l].context.type){
                      if(devices[j].shortSerialNo == self.accessories[l].context.shortSerialNo){
                        skipThermo = true;
                        //refresh zoneID/room to avoid error by changing room
                        self.accessories[l].context.zoneID = response[i].id;
                        self.accessories[l].context.room = response[i].name;
                        if(self.accessories[l].context.type != self.types.boilerThermostat){
                          self.accessories[l].context.batteryState = devices[j].batteryState;
                          if(self.accessories[l].context.batteryState == 'NORMAL'){
                            self.accessories[l].context.batteryLevel = 100;
                            self.accessories[l].context.batteryStatus = 0;
                          } else {
                            self.accessories[l].context.batteryLevel = 10;
                            self.accessories[l].context.batteryStatus = 1;
                          }
                        }
                        //self.removeAccessory(self.accessories[l]); //FOR DEVELOPING
                      }
                    }
                  }
                  //Adding    
                  if(!skipThermo){
                    parameter['zoneID'] = response[i].id;
                    parameter['room'] = response[i].name;
                    parameter['name'] = response[i].name + ' ' + devices[j].shortSerialNo;
                    parameter['shortSerialNo'] = devices[j].shortSerialNo;
                    devices[j].deviceType != 'BU01' ? parameter['batteryState'] = devices[j].batteryState : parameter['batteryState'] = 'NORMAL';
                    if(devices[j].deviceType == 'BU01'){
                      parameter['type'] = self.types.boilerThermostat;
                      parameter['extraType'] = self.types.boilerThermostat;
                      parameter['logging'] = false;
                    } else if(devices[j].deviceType == 'RU01'){
                      parameter['type'] = self.types.radiatorThermostat;
                      parameter['extraType'] = self.types.remoteThermostat;
                      parameter['logging'] = true;
                      parameter['loggingType'] = 'weather';
                      parameter['loggingTimer'] = true;
                    } else {
                      parameter['type'] = self.types.radiatorThermostat;
                      parameter['extraType'] = self.types.radiatorThermostat;
                      parameter['logging'] = true;
                      parameter['loggingType'] = 'weather';
                      parameter['loggingTimer'] = true;
                    }
                    parameter['model'] = devices[j].deviceType;
                    parameter['username'] = self.config.username;
                    parameter['password'] = self.config.password;
                    parameter['url'] = self.config.url;
                    new Device(self, parameter, true);
                  }
                }
              } 
            }
          }
        }
        //Removing
        for(const i in self.accessories){
          if(self.accessories[i].context.type == self.types.radiatorThermostat && self.accessories[i].context.extraType == self.types.radiatorThermostat){
            if(self.config.radiatorThermostat){
              if(!thermoArray.includes(self.accessories[i].context.shortSerialNo)){
                self.removeAccessory(self.accessories[i]);
              }
            } else {
              self.removeAccessory(self.accessories[i]);
            }
          } else if(self.accessories[i].context.type == self.types.boilerThermostat && self.accessories[i].context.extraType == self.types.boilerThermostat){
            if(self.config.boilerThermostat){
              if(!thermoArray.includes(self.accessories[i].context.shortSerialNo)){
                self.removeAccessory(self.accessories[i]);
              }
            } else {
              self.removeAccessory(self.accessories[i]);
            }
          } else if(self.accessories[i].context.type == self.types.radiatorThermostat && self.accessories[i].context.extraType == self.types.remoteThermostat){
            if(self.config.remoteThermostat){
              if(!thermoArray.includes(self.accessories[i].context.shortSerialNo)){
                self.removeAccessory(self.accessories[i]);
              }
            } else {
              self.removeAccessory(self.accessories[i]);
            }
          } else if(self.accessories[i].context.type == self.types.radiatorThermostat && self.accessories[i].context.extraType == self.types.onePerRoom){
            if(self.config.onePerRoom){
              if(!extraArray.includes(self.accessories[i].context.zoneID)){
                self.removeAccessory(self.accessories[i]);
              }
            } else {
              self.removeAccessory(self.accessories[i]);
            }
          } else if(self.accessories[i].context.type == self.types.externalSensor){
            if(self.config.externalSensor){
              if(!extraArray.includes(self.accessories[i].context.zoneID)){
                self.removeAccessory(self.accessories[i]);
              }
            } else {
              self.removeAccessory(self.accessories[i]);
            }
          } else if(self.accessories[i].context.type == self.types.windowSensor){
            if(self.config.openWindow){
              if(!windowArray.includes(self.accessories[i].context.zoneID)){
                self.removeAccessory(self.accessories[i]);
              }
            } else {
              self.removeAccessory(self.accessories[i]);
            }
          }
        }
        self.error.thermostats = 0;
        setTimeout(function(){
          self.checkingThermostats(parameter);
        }, 15000);
      })
      .catch((err) => {
        if(self.error.thermostats > 5){
          self.error.thermostats = 0;
          self.logger.error('An error occured by getting devices, trying again...');
          self.logger.error(err);
          setTimeout(function(){
            self.checkingThermostats(parameter);
          }, 60000);
        } else {
          self.error.thermostats += 1;
          setTimeout(function(){
            self.checkingThermostats(parameter);
          }, 30000);
        }
      });
  },
  
  checkingUser: function (parameter) {
    const self = this;
    let countUser = 0;
    const userArray = [];  
    self.getContent(self.config.url + 'homes/' + parameter.homeID + '/mobileDevices?username=' + self.config.username + '&password=' + self.config.password)
      .then((data) => {
        const response = JSON.parse(data);  
        for(const i in response){	        
          if(response[i].settings.geoTrackingEnabled){	        
            userArray.push(response[i].id);                
            let skipUser = false;    
            let skipAnyone = false;   
            countUser += 1;  
            for(const l in self.accessories){
              if(self.accessories[l].context.type == self.types.occupancy){
                if(response[i].id == self.accessories[l].context.shortSerialNo){
                  skipUser = true;
                  self.accessories[l].context.atHome = response[i].location.atHome;
                }
                if(self.accessories[l].displayName == self.config.name + ' Anyone'){
                  skipAnyone = true;
                  if(response[i].location.atHome)self.accessories[l].context.atHome = true;
                }
              }
            }
            //Adding    
            if(!skipUser){
              parameter['name'] = response[i].name;
              parameter['shortSerialNo'] = response[i].id;
              parameter['type'] = self.types.occupancy;
              parameter['model'] = response[i].deviceMetadata.model;
              parameter['username'] = self.config.username;
              parameter['password'] = self.config.password;
              parameter['url'] = self.config.url;
              parameter['logging'] = true;
              parameter['loggingType'] = 'motion';
              parameter['loggingTimer'] = true;
              response[i].settings.geoTrackingEnabled ? parameter['atHome'] = response[i].location.atHome : parameter['atHome'] = false;
              new Device(self, parameter, true);
            }   
            if(!skipAnyone){
              parameter['name'] = self.config.name + ' Anyone';
              parameter['shortSerialNo'] = '1234567890';
              parameter['type'] = self.types.occupancy;
              parameter['model'] = 'Occupancy Sensor';
              parameter['username'] = self.config.username;
              parameter['password'] = self.config.password;
              parameter['url'] = self.config.url;
              parameter['atHome'] = false;
              parameter['logging'] = true;
              parameter['loggingType'] = 'motion';
              parameter['loggingTimer'] = true;
              new Device(self, parameter, true);
            } 
          }  
        }
        //Removing
        for(const i in self.accessories){
          if(self.accessories[i].context.type == self.types.occupancy){
            if(!userArray.includes(self.accessories[i].context.shortSerialNo) && self.accessories[i].displayName != self.config.name + ' Anyone'){
              self.removeAccessory(self.accessories[i]);
            } else {
              if(self.accessories[i].displayName == self.config.name + ' Anyone'){
                if(countUser == 0){
                  self.removeAccessory(self.accessories[i]); 
                }
              }
            }
          }
        }
        self.error.occupancy = 0;
        setTimeout(function(){
          self.checkingUser(parameter);
        }, 15000);
      })
      .catch((err) => {
        if(self.error.occupancy > 5){
          self.error.occupancy = 0;
          self.logger.error('An error occured by getting user, trying again...');
          self.logger.error(err);
          setTimeout(function(){
            self.checkingUser(parameter);
          }, 60000);
        } else {
          self.error.occupancy += 1;
          setTimeout(function(){
            self.checkingUser(parameter);
          },30000);
        }
      });
  },
  
  initPlatform: function (parameter) {
    const self = this;
   
    if (this.config.centralSwitch) {
      let skip = false;
      for (const i in this.accessories) {
        if (this.accessories[i].context.type == this.types.central) {
          skip = true;
        }
      }
      if (!skip) {
        parameter['name'] = this.config.name + ' Central Switch';
        parameter['shortSerialNo'] = parameter.homeID + '-' + this.types.central;
        parameter['type'] = this.types.central;
        parameter['model'] = 'Central Switch';
        parameter['username'] = this.config.username;
        parameter['password'] = this.config.password;
        parameter['url'] = this.config.url;
        parameter['logging'] = false;
        new Device(self, parameter, true);
      }
    } else {
      for (const i in this.accessories) {
        if (this.accessories[i].context.type == this.types.central) {
          this.removeAccessory(this.accessories[i]);
        }
      }
    }
    
    if (this.config.occupancy) {
      self.logger.info('Connecting to API and looking for new user...');
      self.checkingUser(parameter);
    } else {
      for (const i in this.accessories) {
        if (this.accessories[i].context.type == this.types.occupancy) {
          this.removeAccessory(this.accessories[i]);
        }
      }
    }
    
    if (this.config.weather) {
      let skip = false;
      for (const i in this.accessories) {
        if (this.accessories[i].context.type == this.types.weather) {
          skip = true;
        }
      }
      if (!skip) {
        parameter['name'] = this.config.name + ' Weather';
        parameter['shortSerialNo'] = parameter.homeID + '-' + this.types.weather;
        parameter['type'] = this.types.weather;
        parameter['model'] = 'Weather';
        parameter['username'] = this.config.username;
        parameter['password'] = this.config.password;
        parameter['url'] = this.config.url;
        parameter['logging'] = true;
        parameter['loggingType'] = 'weather';
        parameter['loggingTimer'] = true;
        parameter['key'] = self.config.extendedWeatherKey;
        parameter['activate'] = self.config.extendedWeatherActive;
        parameter['location'] = self.config.extendedWeatherLocation;
        new Device(self, parameter, true);
      }
    } else {
      for (const i in this.accessories) {
        if (this.accessories[i].context.type == this.types.weather) {
          this.removeAccessory(this.accessories[i]);
        }
      }
    }
    
    if (this.config.solarIntensity) {
      let skip = false;
      for (const i in this.accessories) {
        if (this.accessories[i].context.type == this.types.solar) {
          skip = true;
        }
      }
      if (!skip) {
        parameter['name'] = this.config.name + ' Solar Intensity';
        parameter['shortSerialNo'] = parameter.homeID + '-' + this.types.solar;
        parameter['type'] = this.types.solar;
        parameter['model'] = 'Solar Intensity';
        parameter['username'] = this.config.username;
        parameter['password'] = this.config.password;
        parameter['url'] = this.config.url;
        parameter['logging'] = false;
        new Device(self, parameter, true);
      }
    } else {
      for (const i in this.accessories) {
        if (this.accessories[i].context.type == this.types.solar) {
          this.removeAccessory(this.accessories[i]);
        }
      }
    }
  },

  configureAccessory: function (accessory) {
    const self = this;
    self.logger.info('Configuring accessory from cache: ' + accessory.displayName);
    accessory.reachable = true;  
    if(accessory.context.logging){
      accessory.context.loggingService = new FakeGatoHistoryService(accessory.context.loggingType,accessory,accessory.context.loggingOptions);
      accessory.context.loggingService.subtype = accessory.context.shortSerialNo;
      accessory.context.loggingService.log = self.log;
    }
    self.accessories[accessory.displayName] = accessory;
    new Device(self, accessory, false);
  },

  removeAccessory: function (accessory) {
    if (accessory) {
      this.log.warn('Removing accessory: ' + accessory.displayName + '. No longer configured.');
      this.api.unregisterPlatformAccessories(pluginName, platformName, [accessory]);
      delete this.accessories[accessory.displayName];
    }
  }

};
