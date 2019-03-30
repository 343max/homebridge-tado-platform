'use strict';

const debug = require('debug')('TadoPlatform');
const timeout = ms => new Promise(res => setTimeout(res, ms));

class tadoHandler {
  constructor (platform) {

    this.platform = platform;
    this.log = platform.log;
    this.logger = platform.logger;
    this.debug = debug;
    this.api = platform.api;
    this.config = platform.config;
    this.accessories = platform.accessories;
    
    this.tado = platform.tado;
    
    this.dnsError = 0;
    
    this.refreshDevices();
        
    if(this.config.weather || this.config.solarIntensity) 
      this.refreshWeather();

  }
  
  async refreshDevices() {
  
    try {
    
      let zones;   
      let deviceArray = [];
     
      let homeZones = await this.tado.getZones(this.config.homeID);

      zones = await homeZones.map( zone => {

        zone.devices.map( device => {
          
          deviceArray.push({
            name: zone.name + ' ' + device.serialNo,
            zoneID: zone.id,
            zoneName: zone.name,
            zoneType: zone.type,
            deviceType: device.deviceType,
            //capabilities: device.capabilities,
            serial: device.serialNo,
            batteryState: device.batteryState,
            type: 'thermostat'
          });

        });

        if(this.config.openWindow)
          deviceArray.push({
            name: zone.name + ' Window',
            id: zone.id,
            window: zone.openWindowDetection,
            enabled: zone.openWindowDetection.enabled,
            serial: zone.name + '-W',
            type: 'contact'
          });
          
        if(this.config.externalSensor && (zone.type === 'HEATING'))
          deviceArray.push({
            name: zone.name + ' Temperature',
            zoneID: zone.id,
            //zoneType: zone.type,
            serial: zone.name + '-TH',
            type: 'temperature humidity'
          });
          
        let object_zone = {
          zoneID: zone.id,
          name: zone.name,
          type: zone.type,
          deviceTypes: zone.deviceTypes
        };
          
        return object_zone;

      });
      
      if(this.config.occupancy){
      
        await timeout(1000);

        let mobileDevices = await this.tado.getMobileDevices(this.config.homeID);

        await mobileDevices.map( device => {
          
          deviceArray.push({
            name: device.name,
            gps: device.settings ? device.settings.geoTrackingEnabled : false,
            atHome: (device.location && device.location.atHome) ? true : false,
            serial: device.id,
            type: 'occupancy'
          });

        });
        
        if(this.config.anyone){
          deviceArray.push({
            name: 'Anyone',
            serial: '1234567890-OS',
            type: 'occupancy'
          });
        }

      }

      if(this.config.weather)
        deviceArray.push({
          name: 'Weather',
          serial: '1234567890-W',
          type: 'temperature'
        });
        
      if(this.config.solarIntensity)
        deviceArray.push({
          name: 'Solar Intensity',
          serial: '1234567890-SI',
          type: 'lightbulb'
        });

      if(this.config.centralSwitch)
        deviceArray.push({
          name: 'Central Switch',
          serial: '1234567890-CS',
          type: 'switch'
        });
      
      this.deviceArray = deviceArray.filter(function( element ) {
        return element !== undefined;
      });
      
      this.dnsError = 0;
      
      this.refreshZones(zones);
     
    } catch(err) {
    
      this.logger.error('Can not refresh devices!');
    
      if (err.response) {
        if(err.response.status === 500)
          this.dnsError += 1;
    
        // The request was made and the server responded with a status code
        // that falls out of the range of 2xx
        //this.debug(err.response.data);
        this.debug('Status: ' + err.response.status);
        this.debug('Message: ' + err.response.statusText);
        //this.debug(err.response.headers);
      } else if (err.request) {
        // The request was made but no response was received
        // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
        // http.ClientRequest in node.js
        this.debug(err.request);
      } else {
        // Something happened in setting up the request that triggered an Error
        this.debug('Error', err.message ? err.message : err);
      }
    
      if(this.dnsError >= 5){
        this.logger.error('It seems like Tado\'s servers are down.');
        this.logger.error('Requests to Tado are stopped and will be restarted 5 minutes!');
        
        setTimeout(this.refreshDevices.bind(this),5*60*1000);
          
        return;
      }
      
      setTimeout(this.refreshDevices.bind(this),15000);
     
    }
   
  }  
  
  async refreshZones(zones){
  
    if(zones){
    
      try {
    
        /*this.zonesArray = await Promise.all(zones.map( zone => {
                   
          return this.tado.apiCall(`/api/v2/homes/${this.config.homeID}/zones/${zone.zoneID}/state`,'get', {}, {id: zone.zoneID, name: zone.name});
       
        }));*/
        
        let zonesArray = []
        
        for(const i of zones){
        
          await timeout(100)
          
          let state = await this.tado.apiCall(`/api/v2/homes/${this.config.homeID}/zones/${i.zoneID}/state`,'get', {}, {id: i.zoneID, name: i.name});
          
          zonesArray.push(state)
        
        }
        
        this.zonesArray = zonesArray;
        
        setTimeout(this.refreshDevices.bind(this),5000);
    
      } catch(err) {
    
        this.logger.error('Can not refresh zones!');
    
        if (err.response) {
          if(err.response.status === 500)
            this.dnsError += 1;
    
          // The request was made and the server responded with a status code
          // that falls out of the range of 2xx
          //this.debug(err.response.data);
          this.debug('Status: ' + err.response.status);
          this.debug('Message: ' + err.response.statusText);
          //this.debug(err.response.headers);
        } else if (err.request) {
          // The request was made but no response was received
          // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
          // http.ClientRequest in node.js
          this.debug(err.request);
        } else {
          // Something happened in setting up the request that triggered an Error
          this.debug('Error', err.message ? err.message : err);
        }
    
        if(this.dnsError >= 5){
          this.logger.error('It seems like Tado\'s servers are down.');
          this.logger.error('Requests to Tado are stopped and will be restarted 5 minutes!');
        
          setTimeout(this.refreshDevices.bind(this),5*60*1000);
          
          return;
        }
      
        setTimeout(this.refreshDevices.bind(this),15000);
    
      }
    
    }
   
  }
  
  async refreshWeather(){
  
    try {
    
      this.weatherObject = await this.tado.getWeather(this.config.homeID);
      
      this.dnsError = 0;
    
    } catch(err) {
    
      if (err.response) {
        if(err.response.status === 500)
          this.dnsError += 1;
    
        // The request was made and the server responded with a status code
        // that falls out of the range of 2xx
        //this.debug(err.response.data);
        this.debug('Status: ' + err.response.status);
        this.debug('Message: ' + err.response.statusText);
        //this.debug(err.response.headers);
      } else if (err.request) {
        // The request was made but no response was received
        // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
        // http.ClientRequest in node.js
        this.debug(err.request);
      } else {
        // Something happened in setting up the request that triggered an Error
        this.debug('Error', err.message ? err.message : err);
      }
    
      if(this.dnsError >= 5){
        this.logger.error('It seems like Tado\'s servers are down.');
        this.logger.error('Requests to Tado are stopped and will be restarted 5 minutes!');
        return;
      }
    
    }
    
    setTimeout(this.refreshWeather.bind(this),5*1000*60); //5mins
  
  }
  
  getZone(id){
    return new Promise((resolve,reject) => {
      this._handleZones(() => {

        let error = true;

        for(const i in this.zonesArray){
          if(this.zonesArray[i].id === id){
            error = false;
            resolve(this.zonesArray[i]);
          }
        }

        if(error)                                               
          reject('Can not find zone with ID: ' + id);

      });
    });
  } 
  
  getDevice(serial){
    return new Promise((resolve,reject) => {
      this._handleData(() => {

        let error = true;

        for(const i in this.deviceArray){
          if(this.deviceArray[i].serial === serial){
            error = false;
            resolve(this.deviceArray[i]);
          }
        }

        if(error)
          reject('Can not find device with ID: ' + serial);

      });
    });
  }
  
  getData(){
    return new Promise((resolve) => {
      this._handleData(() => resolve(this.deviceArray));
    });
  }
  
  getWeather(){
    return new Promise((resolve) => {
      this._handleWeather(() => resolve(this.weatherObject));
    });
  }
  
  _handleData(callback){
    (this.deviceArray && this.deviceArray.length)? callback() : setTimeout(this._handleData.bind(this,callback),1000);  
  }
  
  _handleZones(callback){
    (this.zonesArray && this.zonesArray.length)? callback() : setTimeout(this._handleZones.bind(this,callback),1000);  
  }
  
  _handleWeather(callback){
    (this.weatherObject && Object.keys(this.weatherObject).length)? callback() : setTimeout(this._handleWeather.bind(this,callback),1000);  
  }

}

module.exports = tadoHandler;