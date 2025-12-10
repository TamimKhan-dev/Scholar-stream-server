require('dotenv').config()
const { format } = require('date-fns');
const express = require('express')
const cors = require('cors')
const { MongoClient, ServerApiVersion } = require('mongodb')
const admin = require('firebase-admin');
const port = process.env.PORT || 3000;
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString(
  'utf-8'
)
const serviceAccount = JSON.parse(decoded)
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
})

const app = express()


// middleware
app.use(
  cors({
    origin: [
      'http://localhost:5173',
      'http://localhost:5174',
      'https://b12-m11-session.web.app',
    ],
    credentials: true,
    optionSuccessStatus: 200,
  })
)
app.use(express.json())

// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(' ')[1]
  console.log(token)
  if (!token) return res.status(401).send({ message: 'Unauthorized Access!' })
  try {
    const decoded = await admin.auth().verifyIdToken(token)
    req.tokenEmail = decoded.email
    console.log(decoded)
    next()
  } catch (err) {
    console.log(err)
    return res.status(401).send({ message: 'Unauthorized Access!', err })
  }
}

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
})


async function run() {
  try {
      const db = client.db('scholar_stream_db');
      const usersCollection = db.collection('users');
      const scholarshipsCollection = db.collection('scholarships');


      // user related API's
      app.post('/users', async (req, res) => {
        const user = req.body;
        user.role = 'student';
        const email = user.email;
        const userExists = await usersCollection.findOne({ email });
        if (userExists) {
          res.status(409).json({message: 'user already exists'});
          return; 
        }
        const result = await usersCollection.insertOne(user);
        res.status(201).json(result);
      })


      // Scholarship related API's
      app.post('/scholarships', async (req, res) => {
          const scholarshipInfo = req.body;
          scholarshipInfo.postDate = format(new Date(), 'dd/MM/yyyy');
          const result = await scholarshipsCollection.insertOne(scholarshipInfo);
          res.status(201).json(result);
      })
      
    // Send a ping to confirm a successful connection
    await client.db('admin').command({ ping: 1 })
    console.log(
      'Pinged your deployment. You successfully connected to MongoDB!'
    )
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir)

app.get('/', (req, res) => {
  res.send('Scholar Stream server is running')
})

app.listen(port, () => {
  console.log(`Server is running on port ${port}`)
})
