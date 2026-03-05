let ws
let token=localStorage.token
let currentChat=null

function connect(){

ws=new WebSocket(location.origin.replace("http","ws"))

ws.onopen=()=>{
ws.send(JSON.stringify({
type:"auth",
token
}))
}

ws.onmessage=(e)=>{
const data=JSON.parse(e.data)

if(data.type==="message"){
addMessage(data.msg)
}

}

}

function send(){

const text=document.getElementById("text").value

ws.send(JSON.stringify({
type:"text-message",
to:currentChat,
text
}))

document.getElementById("text").value=""

}

function addMessage(msg){

const div=document.createElement("div")
div.innerText=msg.sender+": "+msg.text

messages.appendChild(div)

}

connect()
