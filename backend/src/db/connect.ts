import mongoose from "mongoose";
import { env } from "../config/env";

export async function connectDatabase(): Promise<void> {
  await mongoose.connect(env.mongodbUri);
  console.log("Connected to MongoDB");
}
