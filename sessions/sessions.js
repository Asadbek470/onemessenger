const db = require("../database/db")

function listSessions(req,res){

db.all(
`SELECT * FROM sessions WHERE username=?`,
[req.user],
(err,rows)=>{

res.json({ok:true,sessions:rows})

}
)

}

function logoutAll(req,res){

db.run(
`DELETE FROM sessions WHERE username=?`,
[req.user]
)

res.json({ok:true})

}

module.exports={listSessions,logoutAll}
