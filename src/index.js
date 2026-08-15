require('dotenv').config();
const express = require('express');
const cors = require('cors');
const petTourRouter = require('./routes/petTour');

const app = express();

// EC2 위에서 nginx가 리버스 프록시로 앞단에 붙는 구성이라, X-Forwarded-For를 신뢰해야
// express-rate-limit이 nginx의 IP가 아닌 실제 클라이언트 IP 기준으로 제한을 건다.
app.set('trust proxy', 1);

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
