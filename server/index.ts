import { app } from './app.js';
import { syncLeetCode } from './routes/api.js';
app.listen(Number(process.env.PORT || 3001), '127.0.0.1', () => { console.log(`RickyLeet API ready on http://127.0.0.1:${process.env.PORT || 3001}`); void syncLeetCode(); });
