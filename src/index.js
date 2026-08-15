require('dotenv').config();
const express = require('express');
const cors = require('cors');
const petTourRouter = require('./routes/petTour');

const app = express();

app.use(cors({ origin: process.env.CLIENT_ORIGIN || '*' }));
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/api/pet-facilities', petTourRouter);

// 공통 에러 핸들러 - TourAPI 키 미설정/오류를 프론트에 알기 쉽게 전달
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({
    message: err.message || '서버 오류가 발생했습니다.',
    tourApi: err.tourApi || undefined,
  });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`동반하개 server listening on :${PORT}`);
});
