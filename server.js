const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const dotenv = require('dotenv');
const flash = require('connect-flash');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const Doctor = require('./models/Doctor');
const Blog = require('./models/Blog');
const Patient = require('./models/Patient');
const cors = require('cors');

dotenv.config();

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('view engine', 'ejs');
app.use(express.static('public'));

app.use(cors({
  origin: 'http://localhost:3000', // Replace with your frontend's origin
  credentials: true
}));

mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

const sessionStore = MongoStore.create({
  mongoUrl: process.env.MONGODB_URI,
  collectionName: 'sessions',
});

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: { maxAge: 180 * 60 * 1000 } 
}));

app.use(flash());

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser((id, done) => {
  Doctor.findById(id, (err, user) => {
    done(err, user);
  });
});

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: '/auth/google/callback',
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      let user = await Doctor.findOne({ googleId: profile.id });

      if (!user) {
        user = new Doctor({
          googleId: profile.id,
          name: profile.displayName,
          email: profile.emails[0].value,
          role: null, 
        });
        await user.save();
      }

      return done(null, user);
    } catch (err) {
      return done(err);
    }
  }
));

app.use('/auth', require('./routes/auth'));
app.use('/patient', require('./routes/patient'));
app.use('/doctor', require('./routes/doctor'));
app.use('/admin', require('./routes/admin'));

function isLoggedIn(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }
  res.redirect('/auth/login');
}

app.get('/', (req, res) => {
  const user = req.user;
  const patient = req.patient;
  const doctor = req.doctor; 
  res.render('index', { user, patient, doctor });
});


app.post('/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Error destroying session:', err);
    }
    res.redirect('/auth/login');
  });
});
app.use((err, req, res, next) => {
  console.error('Error:', err.stack);
  res.status(500).send('Something broke!');
});

app.get('/auth/search-doctors', async (req, res) => {
  const { what, where, country, state, city, speciality, conditions, languages, gender, availability, dateAvailability, consultation } = req.query;

  try {
    let matchQuery = {
      role: 'doctor',
      verified: 'Verified',
      'timeSlots.status': 'free'
    };

    let projectFields = {
      _id: 1,
      name: 1,
      speciality: 1,
      rating: 1,
      availability: 1,
      city: '$timeSlots.hospitalLocation.city', 
      state: '$timeSlots.hospitalLocation.state', 
      country: '$timeSlots.hospitalLocation.country', 
      hospitals: '$timeSlots.hospital'
    };

    if (country) matchQuery['timeSlots.hospitalLocation.country'] = { $regex: new RegExp(country, 'i') };
    if (state) matchQuery['timeSlots.hospitalLocation.state'] = { $regex: new RegExp(state, 'i') };
    if (city) matchQuery['timeSlots.hospitalLocation.city'] = { $regex: new RegExp(city, 'i') };
    if (speciality) matchQuery.speciality = { $in: [new RegExp(speciality, 'i')] };
    if (languages) matchQuery.languages = { $in: [new RegExp(languages, 'i')] };
    if (gender) matchQuery.gender = gender;
    if (availability) matchQuery.availability = availability === 'true';
    if (consultation) matchQuery.consultation = consultation;

    if (conditions) {
      const conditionsArray = conditions.split(',').map(cond => new RegExp(cond.trim(), 'i'));
      matchQuery.conditions = { $in: conditionsArray };
    }

    if (what) {
      matchQuery.$or = [
        { speciality: { $regex: new RegExp(what, 'i') } },
        { name: { $regex: new RegExp(what, 'i') } },
        { conditions: { $regex: new RegExp(what, 'i') } }
      ];
    }

    if (where) {
      matchQuery.$or = [
        { 'timeSlots.hospitalLocation.city': { $regex: new RegExp(where, 'i') } },
        { 'timeSlots.hospitalLocation.state': { $regex: new RegExp(where, 'i') } },
        { 'timeSlots.hospitalLocation.country': { $regex: new RegExp(where, 'i') } }
      ];
    }

    if (dateAvailability) {
      const searchDate = new Date(dateAvailability);
      matchQuery['timeSlots.date'] = searchDate;
    }

    const pipeline = [
      { $match: matchQuery },
      { $project: projectFields }
    ];

    const doctors = await Doctor.aggregate(pipeline);
    res.json(doctors);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching doctors', error });
  }
});

app.get('/auth/countries', async (req, res) => {
  try {
    const countries = await Doctor.aggregate([
      { $match: { role: 'doctor', verified: 'Verified', 'timeSlots.status': 'free' } },
      { $group: { _id: '$timeSlots.hospitalLocation.country' } },
      { $project: { _id: 0, country: '$_id' } }
    ]);
    const countryList = countries.map(country => country.country);
    res.json(countryList);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching countries', error });
  }
});


app.get('/auth/states', async (req, res) => {
  try {
    const states = await Doctor.aggregate([
      { $match: { role: 'doctor', verified: 'Verified', 'timeSlots.status': 'free' } },
      { $group: { _id: '$timeSlots.hospitalLocation.state' } },
      { $project: { _id: 0, state: '$_id' } }
    ]);
    const stateList = states.map(state => state.state);
    res.json(stateList);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching states', error });
  }
});


app.get('/auth/cities', async (req, res) => {
  try {
    const cities = await Doctor.aggregate([
      { $match: { role: 'doctor', verified: 'Verified', 'timeSlots.status': 'free' } },
      { $group: { _id: '$timeSlots.hospitalLocation.city' } },
      { $project: { _id: 0, city: '$_id' } }
    ]);
    const cityList = cities.map(city => city.city);
    res.json(cityList);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching cities', error });
  }
});


app.get('/auth/hospitals', async (req, res) => {
  try {
    const hospitals = await Doctor.aggregate([
      { $match: { role: 'doctor', verified: 'Verified', 'timeSlots.status': 'free' } },
      { $unwind: '$timeSlots' },
      { $group: { _id: '$timeSlots.hospital' } },
      { $project: { _id: 0, hospital: '$_id' } }
    ]);
    const hospitalList = hospitals.map(hospital => hospital.hospital);
    res.json(hospitalList);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching hospitals', error });
  }
});


app.get('/auth/languages', async (req, res) => {
  try {
    const languages = await Doctor.distinct('languages');
    res.json(languages);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching languages', error });
  }
});

app.get('/auth/specialities', async (req, res) => {
  try {
    const specialities = await Doctor.distinct('speciality');
    res.json(specialities);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching specialities', error });
  }
});

app.get('/auth/conditions', async (req, res) => {
  try {
      const conditions = await Doctor.distinct('conditions');
      res.json(conditions);
  } catch (error) {
      res.status(500).json({ message: 'Error fetching conditions', error });
  }
});

app.get('/auth/what-options', async (req, res) => {
  try {
    const specialities = await Doctor.distinct('speciality');
    const doctors = await Doctor.find({}, 'name').lean();
    const doctorNames = doctors.map(doctor => doctor.name);
    const conditions = await Doctor.distinct('conditions');

    res.json({
      specialities,
      conditions,
      doctors: doctorNames
    });
  } catch (error) {
    res.status(500).json({ message: 'Error fetching what options', error });
  }
});


app.get('/auth/where-options', async (req, res) => {
  try {
    const citiesFromTimeSlots = await Doctor.distinct('timeSlots.hospitalLocation.city');
    const statesFromTimeSlots = await Doctor.distinct('timeSlots.hospitalLocation.state');
    const countriesFromTimeSlots = await Doctor.distinct('timeSlots.hospitalLocation.country');

    const citiesFromHospitals = await Doctor.distinct('hospitals.city');
    const statesFromHospitals = await Doctor.distinct('hospitals.state');
    const countriesFromHospitals = await Doctor.distinct('hospitals.country');

    const cities = [...new Set([...citiesFromTimeSlots, ...citiesFromHospitals])];
    const states = [...new Set([...statesFromTimeSlots, ...statesFromHospitals])];
    const countries = [...new Set([...countriesFromTimeSlots, ...countriesFromHospitals])];

    res.json({
      cities,
      states,
      countries
    });
  } catch (error) {
    res.status(500).json({ message: 'Error fetching where options', error });
  }
});


const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
