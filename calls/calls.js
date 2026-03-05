function handleCall(data,sendTo){

if(data.type==="call-offer"){
sendTo(data.to,data)
}

if(data.type==="call-answer"){
sendTo(data.to,data)
}

if(data.type==="ice"){
sendTo(data.to,data)
}

if(data.type==="call-end"){
sendTo(data.to,data)
}

}

module.exports={handleCall}
