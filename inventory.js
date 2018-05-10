var debug = require("debug")("MssInventory")
var moment = require("moment")
var _ = require("underscore")
var Promise = require("bluebird")
var Client = require('ftp')
var fs = require("fs")
var streamToPromise = require("stream-to-promise")
var csv = Promise.promisifyAll(require("csv"))

var c = new Client();
c = Promise.promisifyAll(c)

var inventoryCodes = {
  "AV": "Available",
  "CM": "Committed",
  "DM": "Damaged",
  "IN": "Inspection",
  "OH": "Hold",
  "PN": "Picked Not shipped",
  "QC": "QC Hold",
  "SU": "Suspense",
}

var inventoryClass = {
  "FZ": "Foreign Trade Zone NS: Non Standard",
  "QC": "Customer Quarantine",
  "RG": "Regular",
  "RS": "Retailer Specific Product",
  "RW": "Rework",
  "SC": "Return Merchandise - Scrap",
  "SL": "Return Merchandise - Sell",
  "UR": "Unknown Receipt",
  "UT": "Unknown Return",
}

function inventory(creds){
  c.connect(creds)
  return Promise.resolve(false).then(function(){
    // ready the connection to FTP server
    return c.onAsync("ready")
  }).then(function(){
    // change directory into the inventory folder
    return c.cwdAsync("./")
  }).then(function(list){
    // list all files in inventory folder
    return c.listAsync()
  }).then(function(list){

    var orderedFiles = _.chain(list).map(function(file){
      // map list of files to contain only name
      return file.name
    }).filter(function(name){
      // filter out files that dont match inventory file name
      return name.match(/^INVENTORY_RPT_V2/)
    }).map(function(file){
      // map array to object with unix timestamp of file name date
      return {
        "name": file,
        "unix_timestamp": moment(file.split("-")[1], "YYYYMMDD").unix(),
      }
    }).sortBy(function(file){
      // sort the array objects by unix timestamp
      return file.unix_timestamp
    }).value()

    if(orderedFiles.length === 0){
      throw new Error("No File Found");

      return;
    }
    // get the last item in the sorted array
    var latestFile = _.last(orderedFiles)

    //var latestFile = _.first(_.last(orderedFiles, 4))


    // get all files in the list that match latest timestamp
    var filesWithLatestTimestamp = _.where(orderedFiles, {
      "unix_timestamp": latestFile.unix_timestamp
    })

    // if more then one file exists with same timestamp throw error
    if(filesWithLatestTimestamp.length !== 1){
      throw new Error("multiple inventory files with same datestamp")
    }

    // return the original ftp file object of latest inventory file
    return _.findWhere(list, {
      "name": latestFile.name
    })

  })
  //.tap(console.log) gives file name
  .then(function(file){
    debug("latest inventory file %s", file.name)
    // get the contents of the file
    return c.getAsync(file.name)
  }).then(function(fileStream){
    // turn the stream into a buffer
    return streamToPromise(fileStream)
  }).then(function(fileBuffer){
    // turn the buffer into a utf8 string
    return fileBuffer.toString('utf8')
  }).then(function(fileString){

    // compensate for pipes `|` within cell contents by transforming the
    // document into a normalized csv, moving cells back from end

    var rows = fileString.split("\r\n")
    var header = rows.shift()
    var columns = header.split("|")

    rows  = _.without(rows, "")

    var rows = _.chain(rows).map(function(row){
      var cells = row.split("|")
      if(cells.length == columns.length) return cells
      var rebuild = []
      rebuild[0] = cells[0]
      rebuild[1] = cells[1]
      rebuild[2] = cells[2]
      rebuild[3] = cells[3]
      rebuild[4] = cells[4]
      rebuild[5] = cells[5]
      rebuild[6] = cells[6] + '|' + cells[7]
      rebuild[7] = cells[8]
      rebuild[8] = cells[9]
      return rebuild
    }).map(function(row){
      var cells = _.map(row, function(cell){
        return JSON.stringify(cell)
      })
      return cells.join(",")
    }).value()

    rows.unshift(_.map(columns, JSON.stringify).join(","))
    rows = rows.join("\n")

    return rows
  })
  .then(function(fileString){
    // turn the CSV string into an object
    return csv.parseAsync(fileString, {
      "columns": true,
      "escape": "\\",
    })
  })

  .then(function(fileCollection){
    // group by sku (SKUs may be duplicated across multiple rows)
    return _.groupBy(fileCollection, function(product){
      return product.ITEM
    })
  })
  .then(function(fileObject){
    // extracts (filter & map) available / regular inventory numbers only

    function availableRegularInventory(products){
      return _.findWhere(products, {
        "INVENTORYCLASS": "RG",
        "INVSTATUS": "AV"
      })
    }

    var extracted = _.chain(fileObject)
      .filter(availableRegularInventory)
      .map(availableRegularInventory)
      .value()

    //console.log(_.size(fileObject))
    //console.log(_.size(extracted))

    return extracted

  }).then(function(fileCollection){
    c.end()
    return fileCollection
  }).catch(function(err){
    c.end()
    throw err
  })
}

module.exports = inventory
