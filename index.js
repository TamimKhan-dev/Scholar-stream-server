require("dotenv").config();
const { format, parse, isAfter } = require("date-fns");
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const port = process.env.PORT || 3000;
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf-8"
);
const serviceAccount = JSON.parse(decoded);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();

// middleware
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://localhost:5174",
      "https://b12-m11-session.web.app",
    ],
    credentials: true,
    optionSuccessStatus: 200,
  })
);

// Mongodb Collections
let db
let applicationsCollection;
let scholarshipsCollection;
let usersCollection;

// Stripe webhook
app.post(
  "/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.log("Webhook signature verification failed.", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const applicationId = session.metadata.applicationId;

      await applicationsCollection.updateOne(
        { _id: new ObjectId(applicationId) },
        {
          $set: {
            paymentStatus: "paid",
            applicationDate: new Date(),
          },
        }
      );

      console.log(`Payment completed for application ${applicationId}`);
    }

    res.json({ received: true });
  }
);

app.use(express.json());

// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  console.log(token);
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    console.log(decoded);
    next();
  } catch (err) {
    console.log(err);
    return res.status(401).send({ message: "Unauthorized Access!", err });
  }
};

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    db = client.db("scholar_stream_db");
    usersCollection = db.collection("users");
    scholarshipsCollection = db.collection("scholarships");
    applicationsCollection = db.collection("applications");

    await applicationsCollection.createIndex(
      { userId: 1, scholarshipId: 1 },
      { unique: true }
    );

    // user related API's
    app.post("/users", async (req, res) => {
      const user = req.body;
      const email = user.email;
      const userExists = await usersCollection.findOne({ email });
      if (userExists) {
        res.status(409).json({ message: "user already exists" });
        return;
      }
      user.role = "student";
      const result = await usersCollection.insertOne(user);
      res.status(201).json(result);
    });

    app.get("/users", async (req, res) => {
      const query = {};
      const result = await usersCollection.find(query).toArray();
      res.status(200).json(result);
    });

    app.get("/users/:email", async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const result = await usersCollection.findOne(query);
      res.status(200).json(result);
    });

    app.patch("/users/:id", async (req, res) => {
      const id = req.params.id;
      const updatedRole = { $set: req.body };
      const query = { _id: new ObjectId(id) };
      const result = await usersCollection.updateOne(query, updatedRole);
      res.status(201).json(result);
    });

    app.delete("/users/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await usersCollection.deleteOne(query);
      res.status(200).json(result);
    });

    // Scholarship related API's
    app.post("/scholarships", async (req, res) => {
      const scholarshipInfo = req.body;
      scholarshipInfo.postDate = format(new Date(), "dd/MM/yyyy");
      const result = await scholarshipsCollection.insertOne(scholarshipInfo);
      res.status(201).json(result);
    });

    app.get("/scholarships", async (req, res) => {
      const query = {};
      const result = await scholarshipsCollection.find(query).toArray();
      res.status(200).json(result);
    });

    app.get("/scholarships/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await scholarshipsCollection.findOne(query);
      res.status(200).json(result);
    });

    app.patch("/scholarships/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const scholarshipInfo = {
        $set: {
          ...req.body,
          postDate: format(new Date(), "dd/MM/yyyy"),
        },
      };

      const result = await scholarshipsCollection.updateOne(
        query,
        scholarshipInfo
      );
      res.status(200).json(result);
    });

    // Payment related API's
    app.post("/create-checkout-session", async (req, res) => {
      const { applicationId } = req.body;

      const application = await applicationsCollection.findOne({
        _id: new ObjectId(applicationId),
      });

      const scholarship = await scholarshipsCollection.findOne({
        _id: new ObjectId(application.scholarshipId),
      });

      const totalAmount =
        parseInt(application.applicationFees) +
        parseInt(application.serviceCharge);

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: scholarship.scholarshipName,
                images: [scholarship.universityImage],
              },
              unit_amount: totalAmount * 100,
            },
            quantity: 1,
          },
        ],
        customer_email: application.userEmail,
        mode: "payment",
        metadata: {
          applicationId: applicationId,
        },
        success_url: `${process.env.SITE_DOMAIN}/scholarship/payment-success`,
        cancel_url: `${process.env.SITE_DOMAIN}/scholarship/payment-cancelled/${application.scholarshipId}`,
      });
      res.send({ url: session.url });
    });

    // Application related API's
    app.post("/applications", async (req, res) => {
      const { userId, scholarshipId } = req.body;

      const existingApplication = await applicationsCollection.findOne({
        userId,
        scholarshipId,
      });
      
      const student = await usersCollection.findOne({ _id: new ObjectId(userId) })

      if (student.role !== 'student') {
        return res.status(400).json({ message: 'You need to be a student to apply' })
      }

      if (existingApplication) {
        return res.status(409).json({
          message: "You have already applied for this Scholarship",
        });
      }

      const scholarship = await scholarshipsCollection.findOne({
        _id: new ObjectId(scholarshipId),
      });

      if (!scholarship) {
        return res.status(404).json({ message: "Scholarship not found" });
      }

      const deadline = parse(
        scholarship.applicationDeadline,
        "dd/MM/yyyy",
        new Date()
      );

      if (isAfter(new Date(), deadline)) {
        return res.status(400).json({
          message: "Application deadline has passed",
        });
      }

      const applicationInfo = {
        ...req.body,
        applicationStatus: "pending",
        paymentStatus: "unpaid",
        applicationDate: new Date(),
      };

      const result = await applicationsCollection.insertOne(applicationInfo);

      res.send({ applicationId: result.insertedId });
    });

    app.get('/applications', async (req, res) => {
      const query = {};
      const result = await applicationsCollection.find(query).toArray();
      res.status(200).json(result);
    })

    app.get('/applications/:email', async (req, res) => {
      const email = req.params.email;
      const query = { userEmail: email };
      const result = await applicationsCollection.find(query).toArray();
      res.status(200).json(result);
    })

    app.patch('/applications/feedback/:id', async (req, res) => {
      const { feedback } = req.body
      const updateDoc = {
        $set: {feedback: feedback}
      };
      const query = { _id: new ObjectId(req.params.id) };
      const result = await applicationsCollection.updateOne(query, updateDoc);
      res.status(200).json(result);
    })

    app.patch('/applications/status/:id', async (req, res) => {
      const id = req.params.id;
      const status = req.body;
      const updateDoc = {
        $set: status
      } 
      const query = { _id: new ObjectId(id) };
      const result = await applicationsCollection.updateOne(query, updateDoc);
      res.status(200).json(result);
    })

    app.patch('/applications/reject/:id', async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {applicationStatus: 'rejected'}
      }
      const result = await applicationsCollection.updateOne(query, updateDoc);
      res.status(200).json(result);
    })

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Scholar Stream server is running");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
