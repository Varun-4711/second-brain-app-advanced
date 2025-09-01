import { pipeline } from '@xenova/transformers';

let embedder:any = null;

export async function getEmbedding(text:any) {
  if (!embedder) {
    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  
  // Generate embeddings with mean pooling and normalization
  const result = await embedder(text, { pooling: 'mean', normalize: true });
  
  // result.data is an array of floats representing the embedding
  return Array.from(result.data);
}
