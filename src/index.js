import { config } from './config.js'
import app from './app.js'

app.listen(config.port, () => {
  console.log(`LinkDM backend running on http://localhost:${config.port}`)
})
