import express from 'express';

const app = express();

app.get('/', (req, res) => {
    res.send('Welcome to a Docker tutorial. Lets see if this still works!!!');
});
const port = process.env.PORT || 3000;
app.listen(port, () =>{
    console.log(`Listening on port http://localhost:${port}`);
});