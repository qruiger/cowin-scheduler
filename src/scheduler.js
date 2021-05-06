const fetch = require('node-fetch');
const moment = require('moment');
const crypto = require('crypto-js');
const readline = require('readline');
const user = require('./user');

const baseUrl = 'https://cdn-api.co-vin.in/api';
// because the cloudflare server is blocking node-fetch user agent requests
const userAgent =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36(KHTML, like Gecko) Chrome/90.0.4430.93 Safari/537.36';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const stopExecution = () => {
  console.log('Exiting...');
  process.exit(0);
};

const momentTimeDiff = (a, b, unit = 'seconds') => moment(a).diff(b, unit);

const httpCaller = async (method, body, url, token = '') => {
  try {
    let headers = {
      'content-type': 'application/json',
      'user-agent': userAgent,
    };
    if (token) {
      headers = { ...headers, authorization: `Bearer ${token}` };
    }
    let params = {
      method,
      headers,
    };
    params =
      method === 'POST' ? { ...params, body: JSON.stringify(body) } : params;
    const response = await fetch(url, params);
    if (!response.ok) {
      if (url.includes('schedule')) {
        return response.status;
      }
      throw `Something wrong, received http status code: ${response.status}`;
    }
    const jsonData = await response.json();
    return jsonData;
  } catch (error) {
    throw error;
  }
};

const askQuestion = async (query) => {
  const rL = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) =>
    rL.question(query, (ans) => {
      rL.close();
      resolve(ans);
    })
  );
};

const authenticate = async (mobile) => {
  try {
    // found the key and text in js code of cowin website
    const key = 'CoWIN@$#&*(!@%^&';
    const text = 'b5cab167-7977-4df1-8027-a63aa144f04e';
    const body = {
      mobile,
      secret: crypto.AES.encrypt(text, key).toString(),
    };
    const { txnId } = await httpCaller(
      'POST',
      body,
      `${baseUrl}/v2/auth/generateMobileOTP`
    );
    console.log(`\n${moment().format('HH:mm:ss')} OTP request sent`);
    const otp = await askQuestion('Enter OTP:\n');
    const otpHashed = crypto.SHA256(otp).toString(crypto.enc.Hex);
    const { token } = await httpCaller(
      'POST',
      { txnId, otp: otpHashed },
      `${baseUrl}/v2/auth/validateMobileOtp`
    );
    return token;
  } catch (error) {
    throw error;
  }
};

const getBeneficiaryIds = async (token) => {
  try {
    const { beneficiaries } = await httpCaller(
      'GET',
      {},
      `${baseUrl}/v2/appointment/beneficiaries`,
      token
    );
    console.log('\n\nList of eligible beneficiaries\n');
    let beneficiaryReferenceIds = beneficiaries.map((beneficiary) => {
      const {
        vaccination_status,
        beneficiary_reference_id,
        birth_year,
        name,
      } = beneficiary;
      if (vaccination_status === 'Not Vaccinated') {
        if (2021 - parseInt(birth_year) < 45) {
          console.log('Beneficiary Name: %s', name);
          console.log(
            'Beneficiary Reference Id: %d\n',
            beneficiary_reference_id
          );
          return beneficiary_reference_id;
        }
      }
    });
    beneficiaryReferenceIds = beneficiaryReferenceIds.filter((id) => !!id);
    return beneficiaryReferenceIds;
  } catch (error) {
    console.log(error);
  }
};

const filterCenters = (centers) => {
  const { preferredPincodes, vaccineType, free, above45 } = user;
  let selectedSession = {};
  centers.find((center) => {
    if (
      (preferredPincodes && preferredPincodes.indexOf(center.pincode) > -1) ||
      ((preferredPincodes === undefined ||
        preferredPincodes === null ||
        !preferredPincodes.length) &&
        ((free === true && center.fee_type === 'Free') ||
          (free === false && center.fee_type === 'Paid') ||
          free === undefined ||
          free === null))
    ) {
      const sessions = center.sessions.filter(
        (session) =>
          // (session.available_capacity > 0) &&
          ((session.vaccine && session.vaccine === vaccineType) ||
            vaccineType === undefined ||
            vaccineType === null) &&
          ((above45 === true && session.min_age_limit === 45) ||
            (above45 === false && session.min_age_limit === 18) ||
            above45 === undefined ||
            above45 === null)
      );
      if (sessions.length) {
        console.log(
          `\nFound availability at ${center.name}. Availability: ${sessions[0].available_capacity}\n`
        );
        selectedSession = {
          center: center.center_id,
          session_id: sessions[0].session_id,
          slots: sessions[0].slots,
        };
        return selectedSession;
      }
    }
  });
  return selectedSession;
};

const getAvailableSession = async (user) => {
  try {
    const { districtId } = user;
    const params = new URLSearchParams({
      district_id: districtId || 395,
      date: moment().format('DD-MM-YYYY'),
    });
    const url = `${baseUrl}/v2/appointment/sessions/calendarByDistrict`;
    let selectedSession = {};
    console.log('\n');
    console.log(moment().format('HH:mm:ss'), 'Searching...');
    const startTime = moment();
    while (momentTimeDiff(moment(), startTime, 'minutes') < 5) {
      const { centers } = await httpCaller('GET', {}, `${url}?${params}`);
      const selectedSession = filterCenters(centers);
      if (Object.keys(selectedSession).length) {
        return selectedSession;
      }
      await delay(300);
    }
    console.log('Could not find any slots to book!');
    return selectedSession;
  } catch (error) {
    throw error;
  }
};

const schedule = async (sessionScheduleDetails, token) => {
  try {
    const {
      center_id,
      session_id,
      beneficiaries,
      slots,
    } = sessionScheduleDetails;
    const body = {
      dose: 1,
      center_id,
      session_id,
      beneficiaries,
      slot: slots[0],
    };
    const startTime = moment();
    while (momentTimeDiff(moment(), startTime, 'minutes') < 5) {
      const data = await httpCaller(
        'POST',
        body,
        `${baseUrl}/v2/appointment/schedule`,
        token
      );
      if (data.appointmentId) {
        return data.appointmentId;
      } else {
        console.log(
          `Something wrong, received http status code: ${response.status}`
        );
      }
      await delay(100);
    }
  } catch (error) {
    throw error;
  }
};

const looper = async (question) => {
  while (1) {
    const shouldProceed = await askQuestion(
      `${question}\nConfirm by typing \'Yes\' or \'No\'\n`
    );
    if (['yes', 'y'].includes(shouldProceed.toString().toLowerCase())) {
      return true;
    } else if (['no', 'n'].includes(shouldProceed.toString().toLowerCase())) {
      stopExecution();
    } else {
      console.log("Illegal input. Valid inputs are 'Yes' or 'No'");
    }
  }
};

const init = async () => {
  try {
    const startTime = moment(user.startTime, 'HH:mm:ss').toISOString();
    const bufferTime = 360; // seconds
    if (momentTimeDiff(startTime, moment()) > bufferTime) {
      const delayInMs =
        (momentTimeDiff(startTime, moment()) - bufferTime) * 1000;
      console.log(`OTP will be requested ${
        bufferTime / 60
      } minutes before start time\
      \nSleeping for ${Math.ceil(delayInMs / 1000 / 60)} minutes\n`);
      await delay(delayInMs);
    } else if (momentTimeDiff(startTime, moment()) < 0) {
      console.log('startTime need to be in the future\n');
      stopExecution();
    }
    if (!user.mobile) {
      user.mobile = await askQuestion('Enter Mobile Number: \n');
    }
    const token = await authenticate(user.mobile);
    const beneficiaries = await getBeneficiaryIds(token);
    await looper(
      '\nThe above listed beneficaries will be scheduled for vaccination'
    );
    while (momentTimeDiff(startTime, moment()) > 1) {
      const delayInMs = (momentTimeDiff(startTime, moment()) - 1) * 1000;
      console.log(`\nSlot booking will start exactly at ${user.startTime}\n`);
      await delay(delayInMs);
    }
    console.log('\nReady to rock and roll');
    let sessionDetails = {};
    sessionDetails = await getAvailableSession(user);
    while (!sessionDetails || !Object.keys(sessionDetails).length) {
      if (momentTimeDiff(moment(), startTime, 'seconds') > 600) {
        stopExecution();
      }
      const searchAgain = await looper('\nSearch again?');
      if (searchAgain) {
        sessionDetails = await getAvailableSession(user);
      }
    }
    // to be tested
    // const appointmentId = await schedule({ ...sessionDetails, beneficiaries });
    // console.log(`Successfully booked: ${appointmentId}`);
  } catch (error) {
    console.log(error);
  }
};

init();
