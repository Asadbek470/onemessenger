const db = require("../database/db")

function sendMessage(req,res){

const {text,to}=req.body

db.run(
`INSERT INTO messages(sender,receiver,text,createdAt)
VALUES(?,?,?,datetime('now'))`,
[req.user,to||"global",text]
)

res.json({ok:true})

}

function getMessages(req,res){

db.all(
`SELECT * FROM messages ORDER BY createdAt`,
[],
(err,rows)=>{

res.json({ok:true,messages:rows})

}
)

}

module.exports={sendMessage,getMessages}
