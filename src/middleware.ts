import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();
const SECRET_KEY = process.env.SECRET_KEY as string;

export interface AuthRequest extends Request {
  user?: any;
}

export const middlewareAuth = (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authorization header missing or malformed" });
  }

  const token = authHeader.split(" ")[1];

  try {
    //@ts-ignore  
    const decoded = jwt.verify(token, SECRET_KEY);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};
