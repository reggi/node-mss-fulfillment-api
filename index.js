var inventory = require("./inventory")

function Fulfillment(creds){
  this.creds = creds
  return this
}

Fulfillment.prototype.inventory = function(){
  return inventory(this.creds)
}

module.exports = Fulfillment
