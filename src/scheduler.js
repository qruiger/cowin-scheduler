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
  logWithTimeStamp(`Token expires ${expTimeFromNow}\n`);
};

const isNullOrDefined = (value) => value === null || value === undefined;

const logWithTimeStamp = (message) =>
  console.log(`\n<${moment().format('HH:mm:ss')}> ${message}`);

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
      const errorMessage = `Something wrong, received http status code: ${response.status}`;
      if (['calendar', 'schedule'].some((subStr) => url.includes(subStr))) {
        logWithTimeStamp(errorMessage);
        return response;
      }
      throw errorMessage;
    }
    const jsonData = await response.json();
    return jsonData;
  } catch (error) {
    throw error;
  }
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
    if (token) {
      logWithTimeStamp('Successfully Authenticated.');
      logTokenExpTime(getExpTime(token));
    } else {
      throw 'Authentication failed!';
    }
    const captcha = await getRecaptchaText(token);
    return { token, captcha };
  } catch (error) {
    throw error;
  }
};

const getBeneficiaryIds = async (token, above45, dose) => {
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
      if (
        (dose === 1 && vaccination_status === 'Not Vaccinated') ||
        (dose === 2 && vaccination_status === 'Partially Vaccinated')
      ) {
        let eligible = false;
        if (
          (above45 && moment().year() - parseInt(birth_year) >= 45) ||
          (!above45 && moment().year() - parseInt(birth_year) < 45)
        ) {
          eligible = true;
        }
        if (eligible) {
          console.log('Beneficiary Name: %s', name);
          console.log('Beneficiary Reference Id: %d', beneficiary_reference_id);
          console.log(`Beneficiary Birth Year: ${birth_year}\n`);
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
  const { preferredPincodes, vaccineType, free, above45, dose } = user;
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
          ((dose === 1 && session.available_capacity_dose1 > 0) ||
            (dose === 2 && session.available_capacity_dose2 > 0)) &&
          ((session.vaccine && session.vaccine === vaccineType) ||
            isNullOrDefined(vaccineType)) &&
          ((above45 === true && session.min_age_limit === 45) ||
            (above45 === false && session.min_age_limit === 18) ||
            isNullOrDefined(above45))
      );
      if (sessions.length) {
        const availability =
          dose === 1
            ? sessions[0].available_capacity_dose1
            : sessions[0].available_capacity_dose2;
        console.log(
          `\nFound availability at ${center.name}.\nAvailability: ${availability}`
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

const getAvailableSession = async ({ user, token, expTime }) => {
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
    let selectedSession = null;
    logWithTimeStamp('Searching...');
    const startTime = moment();
    // search for 7 minutes
    while (momentTimeDiff(moment(), startTime) < 420) {
      logWithTimeStamp('Searching...');
      if (momentTimeDiff(moment.unix(expTime), moment()) <= 0) {
        return null;
      }
      const { centers } = await httpCaller('GET', {}, url, token);
      if (centers && centers.length) {
        const selectedSession = filterCenters(centers, user);
        if (Object.keys(selectedSession).length) {
          return selectedSession;
        }
      }
      // fuzzing delay between calls
      await delay(getRandomNumber(1500, 2500));
    }
    logWithTimeStamp('Could not find any slots to book!');
    return selectedSession;
  } catch (error) {
    throw error;
  }
};

const schedule = async ({
  dose,
  captcha,
  center_id,
  session_id,
  beneficiaries,
  slots,
  token,
  expTime,
}) => {
  try {
    const body = {
      dose,
      captcha,
      center_id,
      session_id,
      beneficiaries,
      slot: slots[0],
    };
    logWithTimeStamp('Scheduling...');
    const startTime = moment();
    // try to book slot for 3 minutes
    while (momentTimeDiff(moment(), startTime) < 180) {
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
      // we can't afford to increase the delay here because of limited slots
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
    console.log(`file://${path.resolve('captcha.html')}\n`);
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

const yetAnotherLooper = async ({
  token,
  captcha,
  mobile,
  functionToCall,
  functionParams,
  repeatMessage,
}) => {
  let expTime = getExpTime(token);
  let response = await functionToCall({
    ...functionParams,
    captcha,
    token,
    expTime,
  });
  let newToken = token;
  let newCaptcha = captcha;
  while (!response) {
    logTokenExpTime(expTime);
    if (momentTimeDiff(moment.unix(expTime), moment()) <= 0) {
      logWithTimeStamp('Token expired\n');
      // destructure without declare
      let {} = ({ token: newToken, captcha: newCaptcha } = await authenticate(
        mobile
      ));
      expTime = getExpTime(newToken);
    }
    const repeat = await looper(repeatMessage);
    if (repeat) {
      response = await functionToCall({
        ...functionParams,
        captcha: newCaptcha,
        token: newToken,
        expTime,
      });
    }
  }
  return { response, token: newToken, captcha: newCaptcha };
};

const preStart = async (user) => {
  let { startTime } = user;
  const bufferTime = 300; // send otp request before 5 minutes
  if (!startTime) {
    startTime = await askQuestion(
      '\nEnter start time in HH:mm:ss 24hour format\n'
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
    let { mobile, above45, dose } = user;
    const { districtId, preferredPincodes } = user;
    if (isNullOrDefined(districtId) && preferredPincodes.length > 1) {
      await looper(
        "\ndistrictId was not specified in user.js\nProceed with Mumbai's districtId?"
      );
    }
    if (isNullOrDefined(dose) || ![1, 2].includes(dose)) {
      const doseResponse = await looper(
        '\ndose was not specified in user.js\nProceed to book dose 1?',
        true
      );
      dose = doseResponse ? 1 : 2;
      console.log(`Proceeding to book dose ${dose}`);
    }
    if (!mobile) {
      mobile = await askQuestion('Enter Mobile Number: \n');
    }
    if (isNullOrDefined(above45)) {
      above45 = await looper('\nBeneficiaries above 45?', true);
    }
    const startTime = await preStart(user);
    const { token, captcha } = await authenticate(mobile);
    const beneficiaries = await getBeneficiaryIds(token, above45, dose);
    if (beneficiaries.length === 0) {
      console.log(
        '\nNo beneficaries found eligible as per the filters in user.js'
      );
      stopExecution();
    }
    await looper(
      'The above listed beneficaries will be scheduled for vaccination'
    );
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
    const {
      response: sessionDetails,
      token: newToken,
      captcha: newCaptcha,
    } = await yetAnotherLooper({
      token,
      captcha,
      mobile,
      functionToCall: getAvailableSession,
      functionParams: {
        user: {
          ...user,
          above45,
          dose,
        },
      },
      repeatMessage: '\nSearch again?',
    });
    const { response: appointmentConfirmationNo } = await yetAnotherLooper({
      token: newToken,
      captcha: newCaptcha,
      mobile,
      functionToCall: schedule,
      functionParams: {
        ...sessionDetails,
        beneficiaries,
        dose,
      },
      repeatMessage: '\nTry to Schedule again?',
    });
    logWithTimeStamp(
      `Successfully booked!\nAppointment Confirmation Number: ${appointmentConfirmationNo}\n`
    );
  } catch (error) {
    console.log(`\n${error}`);
  }
};

init();
