//@ts-ignore
import mongoose,{Types} from "mongoose";
import dotenv from "dotenv";
import { required } from "zod/mini";

dotenv.config(); 

// MongoDB connection
const MONGO_URI = process.env.MONGO_URI as string;
// mongoose.set('debug', true);
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("Connected to MongoDB"))
  .catch((err:any) => console.error("Error connecting to MongoDB:", err));

//console.log('mongoose.connection.name =', mongoose.connection.name);


// User schema and model
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    isShared: { type: Boolean, default: false },
  });

  
  
export const User = mongoose.model("User", userSchema); 


const contentTypes = ["image", "video", "article", "audio"]; // Extend as needed

const contentSchema = new mongoose.Schema({
  link: { type: String, required: true },
  type: { type: String, enum: contentTypes, required: true },
  title: { type: String, required: true },           // user title
  youtubeTitle: { type: String },                      // official YouTube title
  youtubeDescription: { type: String },                // official YouTube description
  thumbnailUrl: { type: String },                       // YouTube thumbnail URL
  embeddingId: { type: String },                        // Pinecone vector reference
  tags: [{ type: Types.ObjectId, ref: 'Tag' }],
  userId: { type: Types.ObjectId, ref: 'User', required: true },
});


export const Content = mongoose.model("Content", contentSchema);


const tagSchema = new mongoose.Schema({
  title: { type: String, required: true, unique: true }
});

export const Tag = mongoose.model('Tag', tagSchema);
