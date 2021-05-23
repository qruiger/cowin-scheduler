const fetch = require('node-fetch');
const moment = require('moment');
const crypto = require('crypto-js');
const readline = require('readline');
const jwtDecode = require('jwt-decode');
const fs = require('fs');
const path = require('path');
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

const getRandomNumber = (min, max) =>
  Math.floor(Math.random() * (max - min + 1) + min);

const getExpTime = (token) => {
  const decodedToken = jwtDecode(token);
  const { exp: expTime } = decodedToken;
  return expTime;
};

const logTokenExpTime = (expTime) => {
  const expTimeFromNow = moment.unix(expTime).fromNow();
  logWithTimeStamp(`Token expire ${expTimeFromNow} \n`);
};

const isNullOrDefined = (value) => value === null || value === undefined;

const logWithTimeStamp = (message) =>
  console.log(`\n<${moment().format('HH:mm:ss')}> ${message}`);

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
      if (
        ['calendarByDistrict', 'schedule'].some((subStr) =>
          url.includes(subStr)
        )
      ) {
        return response;
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
    logWithTimeStamp('OTP request sent');
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

const getBeneficiaryIds = async (token, above45) => {
  try {
    const { beneficiaries } = await httpCaller(
      'GET',
      {},
      `${baseUrl}/v2/appointment/beneficiaries`,
      token
    );
    console.log('\nList of eligible beneficiaries\n');
    let beneficiaryReferenceIds = beneficiaries.map((beneficiary) => {
      const { vaccination_status, beneficiary_reference_id, birth_year, name } =
        beneficiary;
      if (vaccination_status === 'Not Vaccinated') {
        let eligible = false;
        if (
          (above45 && 2021 - parseInt(birth_year) > 45) ||
          (!above45 && 2021 - parseInt(birth_year) < 45)
        ) {
          eligible = true;
        }
        if (eligible) {
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

const filterCenters = (centers, user) => {
  const { preferredPincodes, vaccineType, free, above45 } = user;
  let selectedSession = {};
  centers.find((center) => {
    if (
      ((preferredPincodes && preferredPincodes.indexOf(center.pincode) > -1) ||
        isNullOrDefined(preferredPincodes) ||
        !preferredPincodes.length) &&
      ((free === true && center.fee_type === 'Free') ||
        (free === false && center.fee_type === 'Paid') ||
        isNullOrDefined(free))
    ) {
      const sessions = center.sessions.filter(
        (session) =>
          session.available_capacity > 0 &&
          ((session.vaccine && session.vaccine === vaccineType) ||
            isNullOrDefined(vaccineType)) &&
          ((above45 === true && session.min_age_limit === 45) ||
            (above45 === false && session.min_age_limit === 18) ||
            isNullOrDefined(above45))
      );
      if (sessions.length) {
        console.log(
          `\nFound availability at ${center.name}. Availability: ${sessions[0].available_capacity}\n`
        );
        selectedSession = {
          center_id: center.center_id,
          session_id: sessions[0].session_id,
          slots: sessions[0].slots,
        };
        return selectedSession;
      }
    }
  });
  return selectedSession;
};

const getAvailableSession = async (user, token) => {
  try {
    const { districtId, preferredPincodes } = user;
    let url;
    if (preferredPincodes.length === 1) {
      const params = new URLSearchParams({
        pincode: preferredPincodes[0],
        date: moment().format('DD-MM-YYYY'),
      });
      url = `${baseUrl}/v2/appointment/sessions/calendarByPin?${params}`;
    } else {
      const params = new URLSearchParams({
        district_id: districtId || 395,
        date: moment().format('DD-MM-YYYY'),
      });
      url = `${baseUrl}/v2/appointment/sessions/calendarByDistrict?${params}`;
    }
    let selectedSession = {};
    logWithTimeStamp('Searching...');
    const startTime = moment();
    // 4 minutes
    while (momentTimeDiff(moment(), startTime) < 240) {
      const { centers } = await httpCaller('GET', {}, url, token);
      if (centers && centers.length) {
        const selectedSession = filterCenters(centers, user);
        if (Object.keys(selectedSession).length) {
          return selectedSession;
        }
      }
      await delay(getRandomNumber(100, 300));
    }
    console.log('Could not find any slots to book!');
    return selectedSession;
  } catch (error) {
    throw error;
  }
};

const schedule = async (sessionScheduleDetails, token, expTime) => {
  try {
    const { captcha, center_id, session_id, beneficiaries, slots } =
      sessionScheduleDetails;
    const body = {
      dose: 1,
      captcha,
      center_id,
      session_id,
      beneficiaries,
      slot: slots[0],
    };
    logWithTimeStamp('Scheduling...');
    const startTime = moment();
    // 6 minutes
    while (momentTimeDiff(moment(), startTime) < 360) {
      if (momentTimeDiff(moment.unix(expTime), moment()) <= 0) {
        return null;
      }
      const data = await httpCaller(
        'POST',
        body,
        `${baseUrl}/v2/appointment/schedule`,
        token
      );
      if (data.appointment_confirmation_no) {
        return data.appointment_confirmation_no;
      } else if (data.status === 409) {
        logWithTimeStamp(`Slots booked!`);
        return null;
      } else if (data.status === 200) {
        logWithTimeStamp(JSON.stringify(data));
        return data;
      } else {
        logWithTimeStamp(
          `Something wrong, received http status code: ${data.status}`
        );
      }
      await delay(getRandomNumber(50, 100));
    }
  } catch (error) {
    throw error;
  }
};

const getRecaptchaText = async (token) => {
  try {
    let { captcha } = await httpCaller(
      'POST',
      {},
      `${baseUrl}/v2/auth/getRecaptcha`,
      token
    );
    captcha = captcha.replace(/\\\//g, '/');
    fs.writeFileSync('captcha.svg', captcha);
    logWithTimeStamp(
      'Saved captcha file successfully.\nCtrl + Click on the link below to view Captcha\n'
    );
    const captchaHtml =
      '<!DOCTYPE html><html><body><img src="captcha.svg"></body></html>';
    fs.writeFileSync('captcha.html', captchaHtml);
    console.log(`file://${path.resolve('captcha.html')}`);
    const captchaText = await askQuestion('Enter Captcha Text:\n');
    return captchaText;
  } catch (error) {
    throw error;
  }
};

const looper = async (question, returnFalseIfNo = false) => {
  while (1) {
    const shouldProceed = await askQuestion(
      `${question}\nConfirm by typing \'Yes\' or \'No\'\n`
    );
    if (['yes', 'y'].includes(shouldProceed.toString().toLowerCase())) {
      return true;
    } else if (['no', 'n'].includes(shouldProceed.toString().toLowerCase())) {
      if (returnFalseIfNo) {
        return false;
      }
      stopExecution();
    } else {
      console.log("Illegal input. Valid inputs are 'Yes' or 'No'");
    }
  }
};

const preStart = async (user) => {
  let { startTime } = user;
  const bufferTime = 300; // send otp request before 5 minutes
  if (!startTime) {
    startTime = await askQuestion(
      'Enter start time in HH:mm:ss 24hour format\n'
    );
    if (!moment(startTime, 'HH:mm:ss', true).isValid()) {
      console.log('Illegal format\n');
      stopExecution();
    }
  }
  startTime = moment(startTime, 'HH:mm:ss').toISOString();
  if (momentTimeDiff(startTime, moment()) > bufferTime) {
    const delayInMs = (momentTimeDiff(startTime, moment()) - bufferTime) * 1000;
    console.log(`\nOTP will be requested ${
      bufferTime / 60
    } minutes before start time\
    \nSleeping for ${Math.ceil(delayInMs / 1000 / 60)} minutes\n`);
    await delay(delayInMs);
  } else if (momentTimeDiff(startTime, moment()) < 0) {
    console.log('startTime need to be in the future\n');
    stopExecution();
  }
  return startTime;
};

const init = async () => {
  try {
    let { mobile, above45, districtId } = user;
    if (isNullOrDefined(districtId)) {
      await looper(
        '\ndistrictId was not specified in user.js\nProceed with Mumbai\'s districtId?\n'
      );
    }
    if (!mobile) {
      mobile = await askQuestion('Enter Mobile Number: \n');
    }
    if (isNullOrDefined(above45)) {
      above45 = await looper('\nBeneficiaries above 45?', true);
    }
    const startTime = await preStart(user);
    let token = await authenticate(mobile);
    let expTime = getExpTime(token);
    const beneficiaries = await getBeneficiaryIds(token, above45);
    await looper(
      'The above listed beneficaries will be scheduled for vaccination'
    );
    const captcha = await getRecaptchaText(token);
    while (momentTimeDiff(startTime, moment(), 'milliseconds') >= 200) {
      const delayInMs =
        momentTimeDiff(startTime, moment(), 'milliseconds') - 200;
      console.log(
        `\nSlot booking will start exactly at ${moment(startTime).format(
          'HH:mm:ss'
        )}\n`
      );
      await delay(delayInMs);
    }
    logWithTimeStamp('Ready to rock and roll\n');
    let sessionDetails = {};
    sessionDetails = await getAvailableSession(user, token);
    while (!sessionDetails || !Object.keys(sessionDetails).length) {
      logTokenExpTime(expTime);
      const searchAgain = await looper('\nSearch again?');
      if (searchAgain) {
        sessionDetails = await getAvailableSession(user);
      }
    }
    // yet to be tested
    let appointmentConfirmationNo = await schedule(
      { ...sessionDetails, beneficiaries, captcha },
      token,
      expTime
    );
    while (!appointmentConfirmationNo) {
      logTokenExpTime(expTime);
      if (momentTimeDiff(moment.unix(expTime), moment()) <= 0) {
        logWithTimeStamp('Token expired\n');
        token = await authenticate(mobile);
        expTime = getExpTime(token);
      }
      const trySchedulingAgain = await looper('\nTry to Schedule again?');
      if (trySchedulingAgain) {
        appointmentConfirmationNo = await schedule(
          { ...sessionDetails, beneficiaries, captcha },
          token,
          expTime
        );
      }
    }
    logWithTimeStamp(
      `Successfully booked!\nAppointment Confirmation Number: ${appointmentConfirmationNo}\n`
    );
  } catch (error) {
    console.log(error);
  }
};

init();
