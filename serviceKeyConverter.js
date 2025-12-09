const fs = require('fs')
const jsonData = fs.readFileSync('./assignment11-starter-firebase-adminsdk.json')
const base64String = Buffer.from(jsonData, 'utf-8').toString('base64')
