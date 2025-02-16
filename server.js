// Load environment variables
require("dotenv").config({ path: "./.env" });
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
console.log("Loaded Google Maps API Key:", GOOGLE_MAPS_API_KEY);

const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();

// Use a permissive CORS policy for testing
app.use(cors());
app.options("*", cors());

app.use(express.json());

// Geocode an address and return its latitude/longitude.
const geocodeAddress = async (address) => {
  try {
    console.log("Geocoding address:", address);
    const response = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
      params: { address, key: GOOGLE_MAPS_API_KEY },
    });
    console.log("Geocode response for address:", address, response.data);
    const location = response.data.results[0]?.geometry?.location;
    return location ? { lat: location.lat, lng: location.lng } : null;
  } catch (error) {
    console.error("Error geocoding address:", error);
    return null;
  }
};

// Compute the geographic epicenter (average) of an array of addresses.
const computeEpicenter = async (addresses) => {
  const geocodedLocations = [];
  for (const address of addresses) {
    const location = await geocodeAddress(address);
    if (location) geocodedLocations.push(location);
  }
  if (geocodedLocations.length === 0) return null;
  const latSum = geocodedLocations.reduce((sum, loc) => sum + loc.lat, 0);
  const lngSum = geocodedLocations.reduce((sum, loc) => sum + loc.lng, 0);
  return { lat: latSum / geocodedLocations.length, lng: lngSum / geocodedLocations.length };
};

// For one origin to a given destination using a specified transport mode.
const getTravelTimeForOrigin = async (origin, destination, mode) => {
  try {
    const response = await axios.get("https://maps.googleapis.com/maps/api/distancematrix/json", {
      params: { origins: origin, destinations: destination, mode, key: GOOGLE_MAPS_API_KEY },
    });
    const duration = response.data.rows[0].elements[0].duration?.value;
    return duration || Infinity;
  } catch (error) {
    console.error("Error fetching travel time for", origin, destination, mode, error);
    return Infinity;
  }
};

// Lookup a nearby venue using a fixed search keyword.
const lookupVenue = async (location, keyword) => {
  try {
    const response = await axios.get("https://maps.googleapis.com/maps/api/place/nearbysearch/json", {
      params: {
        location: `${location.lat},${location.lng}`,
        radius: 1500,
        keyword,
        key: GOOGLE_MAPS_API_KEY,
      },
    });
    if (response.data.results && response.data.results.length > 0) {
      return response.data.results[0];
    }
    return null;
  } catch (error) {
    console.error("Error looking up venue:", error);
    return null;
  }
};

app.post("/compute-location", async (req, res) => {
  const { locations } = req.body;
  console.log("Received locations:", locations);
  if (locations.length < 2) {
    return res.status(400).json({ error: "At least two locations are required." });
  }
  const addresses = locations.map((loc) => loc.address);
  console.log("Extracted addresses:", addresses);

  // Compute the initial epicenter.
  const epicenter = await computeEpicenter(addresses);
  if (!epicenter) return res.status(500).json({ error: "Unable to compute epicenter." });
  console.log("Calculated Epicenter:", epicenter);

  // Grid search around the epicenter.
  const delta = 0.005;
  const gridCandidates = [];
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      gridCandidates.push({ lat: epicenter.lat + i * delta, lng: epicenter.lng + j * delta });
    }
  }
  const candidateResults = await Promise.all(
    gridCandidates.map(async (candidate) => {
      const candidateStr = `${candidate.lat},${candidate.lng}`;
      const travelTimes = await Promise.all(
        locations.map(async (loc) => await getTravelTimeForOrigin(loc.address, candidateStr, loc.transport))
      );
      const validTimes = travelTimes.filter((t) => t !== Infinity);
      const averageTime = validTimes.length > 0 ? validTimes.reduce((sum, t) => sum + t, 0) / validTimes.length : Infinity;
      return { candidate, travelTimes, averageTime };
    })
  );
  candidateResults.sort((a, b) => a.averageTime - b.averageTime);
  const bestCandidate = candidateResults[0];
  if (!bestCandidate) return res.status(500).json({ error: "Unable to compute best meeting point." });
  console.log("Best grid candidate:", bestCandidate.candidate, "Avg time (s):", bestCandidate.averageTime);

  // Fixed search keyword.
  const searchKeyword = "bar, café, restaurant";
  const venue = await lookupVenue(bestCandidate.candidate, searchKeyword);
  let finalVenue = null;
  if (venue) {
    finalVenue = venue;
    console.log("Found venue:", venue.name);
  } else {
    console.log("No venue found near candidate. Falling back to candidate coordinate.");
    finalVenue = {
      name: "Meeting Point",
      vicinity: "No venue found",
      geometry: { location: bestCandidate.candidate },
      place_id: null,
    };
  }
  const venueLocationStr = `${finalVenue.geometry.location.lat},${finalVenue.geometry.location.lng}`;
  const newTravelTimes = await Promise.all(
    locations.map(async (loc) => await getTravelTimeForOrigin(loc.address, venueLocationStr, loc.transport))
  );
  const validNewTimes = newTravelTimes.filter((t) => t !== Infinity);
  const newAverageTime = validNewTimes.length > 0 ? validNewTimes.reduce((sum, t) => sum + t, 0) / validNewTimes.length : Infinity;

  const result = {
    name: finalVenue.name,
    address: finalVenue.vicinity || finalVenue.formatted_address || "Address not available",
    location: finalVenue.geometry.location,
    travelTimes: newTravelTimes,
    averageTime: newAverageTime,
    placeId: finalVenue.place_id,
  };

  console.log("Final meeting point:", result);
  res.json({ bestLocation: result });
});

// Listen on the port provided by Heroku or fallback to 5001 locally.
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
