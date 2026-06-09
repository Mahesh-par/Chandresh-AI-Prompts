import mongoose, { Schema, type InferSchemaType } from "mongoose";

const promptBlockSchema = new Schema(
  {
    id: { type: String, required: true },
    content: { type: String, required: true },
    ChatTime: { type: String, default: "" },
  },
  { _id: false },
);

const scrapeResponseSchema = new Schema(
  {
    success: { type: Boolean, required: true },
    sourceUrl: { type: String, required: true, index: true },
    count: { type: Number },
    results: { type: [promptBlockSchema], default: [] },
    tableName: { type: String },
    ChatTime: { type: String, default: "" },
    scrapedAt: { type: String },
    attachmentImages: { type: [String], default: [] },
    message: { type: String },
    error: { type: String },
    details: { type: String },
  },
  { timestamps: true },
);

export type ScrapeResponseDocument = InferSchemaType<
  typeof scrapeResponseSchema
>;

export const ScrapeResponse = mongoose.model(
  "ScrapeResponse",
  scrapeResponseSchema,
);
