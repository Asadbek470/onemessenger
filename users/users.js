const db = require("../database/db")

function blockUser(req,res){

const {username}=req.body

db.run(
`INSERT INTO blocked_users(blocker,blocked)
VALUES(?,?)`,
[req.user,username]
)

res.json({ok:true})

}

module.exports={blockUser}
