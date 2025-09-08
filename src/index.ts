import express from "express";
import { z } from "zod";
import bcrypt from "bcrypt";
import { User } from "./db.js";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { middlewareAuth } from "./middleware.js";
import type { AuthRequest } from "./middleware.js";
import axios from "axios";
import { Pinecone } from "@pinecone-database/pinecone";
import { Content } from "./db.js";
import { getEmbedding } from "./embeddingService.js";
import { Tag } from "./db.js";
import mongoose from "mongoose";

const port = 3000;
const app = express();
dotenv.config();

app.use(express.json()); // Parses JSON bodies
app.use(express.urlencoded({ extended: true })); // Parses URL-encoded bodies

// Environment variables for APIs and clients
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const PINECONE_API_KEY = process.env.PINECONE_API_KEY!;
const PINECONE_ENV = process.env.PINECONE_ENVIRONMENT!;
const PINECONE_INDEX = process.env.PINECONE_INDEX!;
const PINECONE_INDEX_HOST = process.env.PINECONE_INDEX_HOST!;

// Zod schema for input validation
const signupSchema = z.object({
  username: z.string().min(3).max(10),
  password: z
    .string()
    .min(5)
    .max(20)
    .regex(/[a-z]/, "Must include at least one lowercase letter")
    .regex(/[0-9]/, "Must include at least one number"),
});
//Signup endpoint
app.post("/api/v1/signup", async (req, res) => {
  try {
    // Validating the request body
    const parsedData = signupSchema.parse(req.body);
    const { username, password } = parsedData;

    // Checking if the user already exists
    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(403).send("User already exists with this username");
    }

    // Hash the password before saving
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Save the user to the database with hashed password
    const newUser = new User({ username, password: hashedPassword });
    await newUser.save();

    res.status(200).send("Signed up");
  } catch (err) {
    if (err instanceof z.ZodError) {
      // Input validation error
      //@ts-ignore
      return res.status(411).json({ error: err.errors });
    }

    console.log(err);
    res.status(500).send("Server error");
  }
});

const SECRET_KEY = process.env.SECRET_KEY as string;
// Zod schema for signin validation
const signinSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
//Signin endpoint
app.post("/api/v1/signin", async (req, res) => {
  try {
    const { username, password } = signinSchema.parse(req.body);

    const user = await User.findOne({ username });
    if (!user) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    const payload = { userId: user._id, username: user.username };
    const token = jwt.sign(payload, SECRET_KEY);

    return res.status(200).json({ token });
  } catch (err) {
    if (err instanceof z.ZodError) {
      //@ts-ignore
      return res.status(400).json({ error: err.errors });
    }
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

//---------------------------------------------------------------------------------------------------------------

const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY!,
});
const pineconeIndex = pinecone.index(PINECONE_INDEX!, PINECONE_INDEX_HOST!);
// Helper function to extract YouTube video ID from URL
function extractYouTubeVideoId(url: string): string | null {
  const regex = /(?:youtube\.com.*(?:\?|&)v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
  const match = url.match(regex);
  //@ts-ignore
  return match ? match[1] : null;
}

async function getTagIds(
  tags: string[]
): Promise<Array<mongoose.Types.ObjectId>> {
  const tagIds: mongoose.Types.ObjectId[] = [];

  for (const tagTitle of tags) {
    // Try to find existing tag by title
    let tagDoc = await Tag.findOne({ title: tagTitle });

    // Create if not found
    if (!tagDoc) {
      tagDoc = new Tag({ title: tagTitle });
      await tagDoc.save();
    }

    tagIds.push(tagDoc._id);
  }

  return tagIds;
}

//Adding Content Endpoint
app.post("/api/v1/content", middlewareAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.userId;
    const { link, type, title, tags } = req.body;

    // if (!link || !type || !tags || !Array.isArray(tags) || !userId || !title) {
    //   return res.status(400).json({ error: "Missing required fields." });
    // }
    // Convert tag titles to Tag document ObjectIds
    const tagObjectIds = await getTagIds(tags);

    // Extract YouTube video ID
    const videoId = extractYouTubeVideoId(link);
    if (!videoId) {
      return res.status(400).json({ error: "Invalid YouTube link." });
    }

    // Fetch YouTube video metadata
    const youtubeResponse = await axios.get(
      `https://www.googleapis.com/youtube/v3/videos`,
      {
        params: {
          part: "snippet",
          id: videoId,
          key: YOUTUBE_API_KEY,
        },
      }
    );

    if (!youtubeResponse.data.items.length) {
      return res.status(404).json({ error: "YouTube video not found." });
    }

    const snippet = youtubeResponse.data.items[0].snippet;
    const youtubeTitle = snippet.title;
    const youtubeDescription = snippet.description;
    const thumbnailUrl = snippet.thumbnails?.default?.url || "";
    // Prepare text for embedding
    const embeddingText: string = `${title},${youtubeTitle},${youtubeDescription}`;
    // console.log("YouTube Title: ", youtubeTitle);
    // console.log("YouTube Description: ", youtubeDescription);
    // console.log("YouTube thumbnail: ", thumbnailUrl);

    // Use HF model to get embedding vector
    const embeddingVector = await getEmbedding(embeddingText);
    // console.log(embeddingVector);
    //console.log(Array.isArray(embeddingVector), embeddingVector.length);

    // Create and save content document
    const newContent = new Content({
      link,
      type,
      title,
      youtubeTitle,
      youtubeDescription,
      thumbnailUrl,
      tags: tagObjectIds, // ObjectId array,
      userId,
    });
    //console.log(newContent);

    await newContent.save();
    const vectorId = newContent._id.toString();

    await pineconeIndex.namespace("__default__").upsert([
      {
        id: vectorId,
        //@ts-ignore
        values: embeddingVector,
        metadata: { userId, link, type, title },
      },
    ]);

    // Save embeddingId reference
    newContent.embeddingId = vectorId;
    await newContent.save();

    res
      .status(201)
      .json({ message: "Content saved with embedding!", content: newContent });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Server error." });
  }
});

//Getting All the content (pagination done) Endpoint
app.get("/api/v1/content", middlewareAuth, async (req: AuthRequest, res) => {
  try {
    // Extract user id from JWT (as set by middlewareAuth)
    const userId = req.user.userId; // Ensure your JWT encodes _id or change appropriately
    //console.log(userId);
    const page = Math.max(1, Number(req.query.page) || 1); //GET /api/v1/content?page=1&limit=8
    //to be used when wen say user demands page 2 or anyother page in pagination
    const limit = Math.min(8, Number(req.query.limit) || 8);

    const [contents, total] = await Promise.all([
      Content.find({ userId })
        .populate("tags", "title")
        .sort({ _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      Content.countDocuments({ userId }),
    ]);

    res.status(200).json({
      results: contents,
      total,
      page,
      totalPages: Math.ceil(total / limit),
      hasNextPage: page * limit < total,
      hasPrevPage: page > 1,
    });
  } catch (err) {
    console.error("Error fetching content:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

//Deleting content endpoint
/**
 * DELETE /api/v1/content
 * Deletes a content document and its embedding vector (if exists) by id if owned by authenticated user
 * Body params: { contentId: string }
 */
app.delete("/api/v1/content", middlewareAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user.userId; // Authenticated user ID
    const { contentId } = req.body;

    if (!contentId) {
      return res.status(400).json({ error: "contentId is required" });
    }

    // Find content by id
    const content = await Content.findById(contentId);

    if (!content) {
      return res.status(404).json({ error: "Content not found" });
    }

    // Check ownership
    //@ts-ignore
    if (content.userId.toString() !== userId) {
      return res
        .status(403)
        .json({ error: "Forbidden: Cannot delete content you do not own" });
    }

    // Delete embedding vector from Pinecone if embeddingId exists
    if (content.embeddingId) {
      try {
        const idOfToBeDeletedEmbedding = content.embeddingId;
        //@ts-ignore
        await pineconeIndex.namespace("__default__").deleteOne(idOfToBeDeletedEmbedding);
      } catch (pineconeErr) {
        console.error("Error deleting vector from Pinecone:", pineconeErr);
        // Optionally handle Pinecone error, decide if you want to continue or abort
      }
    }

    // Retrieve tags linked to the content before deletion
    const tagsToCheck = content.tags || []; // content.tags holds tag ObjectIds

    // For each tag, check if it exists in any other content
    for (const tagId of tagsToCheck) {
      const isTagUsedElsewhere = await Content.exists({
        _id: { $ne: contentId },
        tags: tagId,
      });

      // If no other content references this tag, delete it
      if (!isTagUsedElsewhere) {
        await Tag.findByIdAndDelete(tagId);
      }
    }

    // Delete the MongoDB content document
    await Content.findByIdAndDelete(contentId);

    res.status(200).json({ message: "Delete succeeded" });
  } catch (err) {
    console.error("Error deleting content:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

//Searching a query endpoint
/**
 * GET /api/v1/search?q=search terms
 * Semantic search by query string with similarity threshold filtering
 */
app.get("/api/v1/search", middlewareAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user.userId;
    const queryText = req.query.q;

    if (!queryText || typeof queryText !== "string") {
      return res
        .status(400)
        .json({ error: "Missing or invalid query parameter 'q'" });
    }

    // Generate embedding vector for the query text
    const queryEmbedding = await getEmbedding(queryText);

    // Query Pinecone using official targeting syntax and namespace
    const queryResponse = await pineconeIndex.namespace("__default__").query({
      //@ts-ignore
      vector: queryEmbedding,
      topK: 5,
      includeValues: false, // No need for embedding vectors returned
      includeMetadata: true,
    });

    const scoreThreshold = 0.4;
    // Filter results by similarity score threshold
    const filteredMatches = (queryResponse.matches ?? []).filter(
      (match) => match.score !== undefined && match.score >= scoreThreshold
    );

    if (filteredMatches.length === 0) {
      return res.status(200).json({ results: [] });
    }

    const matchedEmbeddingIds = filteredMatches.map((match) => match.id);

    // Fetch content from MongoDB by embeddingId and ensure user ownership
    const matchedContents = await Content.find({
      embeddingId: { $in: matchedEmbeddingIds },
      userId,
    }).populate("tags", "title");

    res.status(200).json({ results: matchedContents });
  } catch (err) {
    console.error("Error during semantic search:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

//Setting the share property end point - /api/v1/brain/share
/**
 * POST /api/v1/brain/share
 * Toggle sharing on/off for the authenticated user
 * Body: { share: boolean }
 */
app.post(
  "/api/v1/brain/share",
  middlewareAuth,
  async (req: AuthRequest, res) => {
    try {
      const userId = req.user.userId;
      const { share } = req.body;

      if (typeof share !== "boolean") {
        return res
          .status(400)
          .json({ error: "Field 'share' must be boolean." });
      }

      const user = await User.findById(userId);
      if (!user) return res.status(404).json({ error: "User not found." });

      user.isShared = share;
      await user.save();

      // Construct share link (example: frontend base url + /brain/share/<userId>)
      const baseUrl = process.env.FRONTEND_URL;
      const link = share ? `${baseUrl}/shared-brain/${user._id}` : null;

      res.status(200).json({ link });
    } catch (err) {
      console.error("Error toggling brain share:", err);
      res.status(500).json({ error: "Internal Server Error" });
    }
  }
);

//Accessing the content through share link
/**
 * GET /api/v1/brain/:shareLink
 * Return username and shared content for the given shareLink userId
 */
app.get("/api/v1/brain/share/:shareLink", async (req: AuthRequest, res) => {
  try {
    const { shareLink } = req.params;

    const user = await User.findById(shareLink);
    if (!user || !user.isShared) {
      return res
        .status(404)
        .json({ error: "Shared brain not found or sharing disabled." });
    }

    // Fetch all content for the shared user
    const contents = await Content.find({ userId: user._id })
      .populate("tags", "title")
      .lean();

    const formattedContents = contents.map((content) => ({
      id: content._id,
      type: content.type,
      link: content.link,
      title: content.title,
      youtubeTitle: content.youtubeTitle,
      youtubeDescription: content.youtubeDescription,
      thumbnailUrl: content.thumbnailUrl,
      //@ts-ignore
      tags: content.tags.map((tag) => tag.title),
      // embeddingId: content.embeddingId,  // Commented: internal use only
      // userId: content.userId,            // Commented: sensitive info
    }));

    res.status(200).json({
      username: user.username,
      content: formattedContents,
    });
  } catch (err) {
    console.error("Error fetching shared brain:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

//Get Tags Endpoint
// app.get("/api/v1/tags", middlewareAuth, async (req: AuthRequest, res) => {
//   try {
//     const userId = req.user.userId;
//     const tags = await Tag.find({}).lean();
//     res.status(200).json(tags);
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ error: "Internal Server Error" });
//   }
// });

app.get("/api/v1/tags", middlewareAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user.userId;

    // Fetch all user content with populated tags
    const contents = await Content.find({ userId }).populate("tags").lean();

    // Collect unique tags
    const tagMap = {};
    contents.forEach(content => {
      content.tags.forEach(tag => {
        //@ts-ignore
        tagMap[tag._id] = tag;
      });
    });

    // Return tags as an array
    const tags = Object.values(tagMap);

    res.status(200).json(tags);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});


//Get content based on tags
app.get(
  "/api/v1/content/tag/:tagId",
  middlewareAuth,
  async (req: AuthRequest, res) => {
    try {
      const userId = req.user.userId;
      const { tagId } = req.params;

      // console.log("User ID:", userId);
      // console.log("Tag ID (string):", tagId);

      if (!tagId) {
        return res.status(400).json({ error: "Tag ID is required" });
      }
      const contents = await Content.find({
        userId,
        tags: { $in: [tagId] },
      })
        .populate("tags", "title")
        .lean();
      // console.log(`Found ${contents.length} contents with tag ${tagId}`);
      //console.log("Sample content:", contents[0] ?? "No content found");
      // console.log("MongoDB query filter:", JSON.stringify(contents));

      res.status(200).json({ contents });
    } catch (err) {
      console.error("Error fetching content by tag:", err);
      res.status(500).json({ error: "Internal Server Error" });
    }
  }
);

//-----------------------------------------------------------------------------------------------------------------
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

// //@ts-ignore
