import express from 'express';
import 'dotenv/config';
import { productsRouter } from './productsRouter.js';import cors from 'cors';
const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use('/', productsRouter);

app.use((req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
});

app.listen(PORT, () => {
  console.log(`Product browser API listening on http://localhost:${PORT}`);
});
