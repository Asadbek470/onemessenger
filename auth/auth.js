const bcrypt = require("bcryptjs")
const jwt = require("jsonwebtoken")
const db = require("../database/db")
const {JWT_SECRET} = require("../config/config")

function register(req,res){

const {username,password}=req.body

bcrypt.hash(password,10,(err,hash)=>{

db.run(
`INSERT INTO users(username,passwordHash,createdAt)
VALUES(?,?,datetime('now'))`,
[username,hash],
err=>{

if(err) return res.json({ok:false,error:"username exists"})

const token = jwt.sign({username},JWT_SECRET)

res.json({ok:true,token})

}
)

})

}

function login(req,res){

const {username,password}=req.body

db.get(
`SELECT * FROM users WHERE username=?`,
[username],
(err,user)=>{

if(!user) return res.json({ok:false})

bcrypt.compare(password,user.passwordHash,(err,valid)=>{

if(!valid) return res.json({ok:false})

const token = jwt.sign({username},JWT_SECRET)

res.json({ok:true,token})

})

})

}

module.exports={register,login}
