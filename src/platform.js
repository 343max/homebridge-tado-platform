'use strict';

const async = require('async');
const Device = require('./accessory.js');

var HomebridgeAPI;

const pluginName = 'homebridge-tado-platform';
const platformName = 'TadoPlatform';

module.exports = function (homebridge) {
  HomebridgeAPI = homebridge;
  return TadoPlatform;
};

function TadoPlatform (log, config, api) {
  if (!api || !config) return;
  if (!config.username || !config.password) throw new Error('Please check your config.json!');

  // HB
  const self = this;
  this.log = log;
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
    weather: config.weather===true
  };
  
  this.config.polling > 10000 ? this.config.polling = 10000 : this.config.polling;

  // STORAGE
  this.storage = require('node-persist');
  this.storage.initSync({
    dir: HomebridgeAPI.user.persistPath()
  });
  
  this.types = {
    thermostat: 1,
    central: 2,
    occupancy: 3,
    weather: 4
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
    this.api = api;
    this.api.on('didFinishLaunching', self.didFinishLaunching.bind(this));
  }
}

TadoPlatform.prototype = {

  didFinishLaunching: function(){
    const self = this;
    self.checkStorage(function (err, state) {
      if(err||!state){
        if(err)self.log(err);
        setTimeout(function(){
          self.didFinishLaunching();
        }, 5000);
      } else {
        self.checkingThermostats(state);
        self.initPlatform(state);
      }
    });  
  },

  checkStorage: function (callback) {
    const self = this;
    if(!self.storage.getItem('Tado_API')){
      self.log('Requesting information from Tado API...');
      const parameter = {};
      async.waterfall([
        function(next) {
          function fetchHomeID(next) {
            self.log('Getting Home ID...');
            self.getContent(self.config.url + 'me?username=' + self.config.username + '&password=' + self.config.password)
              .then((data) => {
                const response = JSON.parse(data);
                parameter['homeID'] = response.homes[0].id;
                next(null, parameter);
              })
              .catch((err) => {
                self.log('An error occured by getting Home ID, trying again...');
                self.log(err);
                setTimeout(function(){
                  fetchHomeID(next);
                }, self.config.polling);
              });
          } fetchHomeID(next);            
        },
        function(parameter, next) {
          function fetchUnit(next){
            self.log('Getting Temperature Unit...');
            self.getContent(self.config.url + 'homes/' + parameter.homeID + '?username=' + self.config.username + '&password=' + self.config.password)
              .then((data) => {
                const response = JSON.parse(data);
                parameter['tempUnit'] = response.temperatureUnit;
                next(null, parameter);
              })
              .catch((err) => {
                self.log('An error occured by getting Temperature Unit, trying again...');
                self.log(err);
                setTimeout(function(){
                  fetchUnit(next);
                }, 30000);
              });
          } fetchUnit(next);
        }
      ], function (err, result) {
        if(err){
          self.log(err);
        } else {
          self.log('Storing Tado_API in cache...');
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
        for(const i in response){
          if(response[i].type == 'HEATING'){
            for(const j in response[i].devices){
              const devices = response[i].devices;
              if(devices[j].deviceType == 'VA01'){
                thermoArray.push(devices[j].serialNo);
                var skipThermo = false;
                for(const l in self.accessories){
                  if(self.accessories[l].context.type == self.types.thermostat){
                    if(devices[j].serialNo == self.accessories[l].context.serialNo){
                      skipThermo = true;
                      self.accessories[l].context.batteryState = devices[j].batteryState;
                      if(self.accessories[l].context.batteryState == 'NORMAL'){
                        self.accessories[l].context.batteryLevel = 100;
                        self.accessories[l].context.batteryStatus = 0;
                      } else {
                        self.accessories[l].context.batteryLevel = 10;
                        self.accessories[l].context.batteryStatus = 1;
                      }
                      //self.removeAccessory(self.accessories[l]); //FOR DEVELOPING
                    }
                  }
                }
                //Adding    
                if(!skipThermo){
                  parameter['zoneID'] = response[i].id;
                  parameter['name'] = response[i].name + ' ' + devices[j].serialNo;
                  parameter['serialNo'] = devices[j].serialNo;
                  parameter['batteryState'] = devices[j].batteryState;
                  parameter['type'] = self.types.thermostat;
                  parameter['model'] = devices[j].deviceType;
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
          }
        }
        //Removing
        for(const i in self.accessories){
          if(self.accessories[i].context.type == self.types.thermostat){
            if(!thermoArray.includes(self.accessories[i].context.serialNo)){
              self.removeAccessory(self.accessories[i]);
            }
          }
        }
        self.error.thermostats = 0;
        setTimeout(function(){
          self.checkingThermostats(parameter);
        }, self.config.polling);
      })
      .catch((err) => {
        if(self.error.thermostats > 5){
          self.error.thermostats = 0;
          self.log('An error occured by getting devices, trying again...');
          self.log(err);
          setTimeout(function(){
            self.checkingThermostats(parameter);
          }, 30000);
        } else {
          self.error.thermostats += 1;
          setTimeout(function(){
            self.checkingThermostats(parameter);
          }, self.config.polling);
        }
      });
  },
  
  checkingUser: function (parameter) {
    const self = this;
    self.getContent(self.config.url + 'homes/' + parameter.homeID + '/mobileDevices?username=' + self.config.username + '&password=' + self.config.password)
      .then((data) => {
        const response = JSON.parse(data);        
        const userArray = [];        
        for(const i in response){
          userArray.push(response[i].id);                
          var skipUser = false;    
          var skipAnyone = false;            
          for(const l in self.accessories){
            if(self.accessories[l].context.type == self.types.occupancy){
              if(response[i].id == self.accessories[l].context.serialNo){
                skipUser = true;
                response[i].settings.geoTrackingEnabled ? self.accessories[l].context.atHome = response[i].location.atHome : self.accessories[l].context.atHome = false;
              }
              if(self.accessories[l].displayName == self.config.name + ' Anyone'){
                skipAnyone = true;
              }
            }
          }
          //Adding    
          if(!skipUser){
            parameter['name'] = response[i].name;
            parameter['serialNo'] = response[i].id;
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
            parameter['serialNo'] = '1234567890';
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
        //Removing
        for(const i in self.accessories){
          if(self.accessories[i].context.type == self.types.occupancy){
            if(!userArray.includes(self.accessories[i].context.serialNo) && self.accessories[i].displayName != self.config.name + ' Anyone'){
              self.removeAccessory(self.accessories[i]);
            }
          }
          if(self.accessories[i].displayName == self.config.name + ' Anyone'){
            if(userArray.length == 0){
              self.removeAccessory(self.accessories[i]); 
            }
          }
        }
        self.error.occupancy = 0;
        setTimeout(function(){
          self.checkingUser(parameter);
        }, self.config.polling);
      })
      .catch((err) => {
        if(self.error.occupancy > 5){
          self.error.occupancy = 0;
          self.log('An error occured by getting user, trying again...');
          self.log(err);
          setTimeout(function(){
            self.checkingUser(parameter);
          }, 30000);
        } else {
          self.error.occupancy += 1;
          setTimeout(function(){
            self.checkingUser(parameter);
          }, self.config.polling);
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
        parameter['serialNo'] = parameter.homeID + '-' + this.types.central;
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
        parameter['serialNo'] = parameter.homeID + '-' + this.types.weather;
        parameter['type'] = this.types.weather;
        parameter['model'] = 'Weather';
        parameter['username'] = this.config.username;
        parameter['password'] = this.config.password;
        parameter['url'] = this.config.url;
        parameter['logging'] = true;
        parameter['loggingType'] = 'weather';
        parameter['loggingTimer'] = true;
        new Device(self, parameter, true);
      }
    } else {
      for (const i in this.accessories) {
        if (this.accessories[i].context.type == this.types.weather) {
          this.removeAccessory(this.accessories[i]);
        }
      }
    }
  },

  configureAccessory: function (accessory) {
    const self = this;
    self.log.info('Configuring accessory from cache: ' + accessory.displayName);
    accessory.reachable = true;
    self.accessories[accessory.displayName] = accessory;
    if(accessory.context.logging) accessory.context.loggingService.log = self.log;
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
