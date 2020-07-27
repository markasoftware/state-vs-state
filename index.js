const fs = require('fs');
const gt = require('google-trends-api');
const unsort = arr => require('array-unsort').unsort(arr, 'fisher-yates');
const states = require('states-us').default
	  .filter(c => !c.territory && c.abbreviation != 'DC')
	  .map(c => c.name);
const sleep = require('sleep-promise');

// we can compare only 5 things at once. We have to get every pair of states.
// There are sum(1..49) = 1225 total pairs of states, and each query we analyze
// sum(1..4) = 10 pairs, so a minimum bound of 123 requests to check all pairs.
// In fact, the true number is higher than this (I know it must be at least 130)

const pairs = [];
for (let i = 0; i < states.length; i++) {
	for (let k = i + 1; k < states.length; k++) {
		pairs.push([states[i], states[k]]);
	}
}

function has(pairList, other) {
	return pairList.find(c =>
						 c[0] === other[0] && c[1] === other[1]
						 || c[0] === other[1] && c[1] === other[0]);
}

console.log(`Total number of pairs: ${pairs.length}`);

// But can we be fully efficient? I.e, can each request check 10 pairs that have
// not already been checked? It's possible that a state will only have one pair
// that hasn't been tested yet, so adding that state to the list of 5 will mean
// a lot of wasted comparisons. I think the weight of this inefficiency must be
// borne.

// A naïve strategy is to go through the states one at a time, in alphabetic
// order or something, and make requests until we've done all pairs involving
// that state. Then, move onto the next state, skipping the pair with the first
// state.

// At first it may seem like the naïve strategy will require 1225 requests, but
// it will not. Indeed, 4 pairs of with the second state will already have been
// processed by the time we finish the first state. The number of already
// processed pairs involving the third state, by the time we get to it, will be
// either 4 or 8, depending on whether the second and third state were in the
// same group during processing of the first state. So it's unclear if this
// algorithm is good or bad. Let's check!

function computeNaivePlan() {

	const plan = [];
	const completedPairs = [];
	let curRequest = [];

	function finishRequest() {
		if (curRequest.length > 0) {
			for (let i = 0; i < curRequest.length; i++) {
				for (let k = i + 1; k < curRequest.length; k++) {
					completedPairs.push([curRequest[i], curRequest[k]]);
				}
			}
			plan.push(curRequest);
			curRequest = [];
		}
	}

	function push(state) {
		if (!curRequest.includes(state)) {
			curRequest.push(state);
		}
	}

	for (let i = 0; i < states.length; i++) {
		const state1 = states[i];
		const states_ = unsort(states);
		for (let k = 0; k < states.length; k++) {
			const state2 = states_[k];
			if (!has(completedPairs, [state1, state2])) {
				push(state1);
				push(state2);
				if (curRequest.length === 5) {
					finishRequest();
				}
			}
		};
		if (curRequest.length > 3) {
			finishRequest();
		}
	};
	finishRequest();

	return plan;

}

const naivePlan = computeNaivePlan();

console.log(`Naïve plan length: ${naivePlan.length}`);

// Observation: Changing the order of `states` before looping has no effect, but
// changing the order of states used for the inner loop only does!

// Furthermore, shuffling states_ for each iteration of the outer loop produces
// markedly better results than shuffling it once at the beginning.

function checkPlan(plan) {
	const planPairs = [];
	plan.forEach(planGroup => {
		if (planGroup.length > 5) {
			throw new Error(`Plan group too long: ${planGroup.length}`);
		}
		for (let i = 0; i < planGroup.length; i++) {
			for (let k = i + 1; k < planGroup.length; k++) {
				const planPair = [planGroup[i], planGroup[k]];
				if (!has(pairs, planPair)) {
					throw new Error(`Invalid pair: ${planPair}`);
				}
				if (!has(planPairs, planPair)) {
					planPairs.push(planPair);
				}
			}
		}
	});
	if (planPairs.length !== 1225) {
		throw new Error(`Incorrect plan length: ${planPairs.length}`);
	}
}

checkPlan(naivePlan);

// Our naïve plans are about 170 long, not so far from our 130 lower bound, and
// are valid! Let's try something a bit different: Prioritizing states 

function computeEfficientPlan() {

	const plan = [];
	const completedPairs = [];
	let curRequest = [];
	let checkingCurRequest = [];

	function finishRequest() {
		if (curRequest.length > 0) {
			plan.push(curRequest);
			curRequest = [];
			checkingCurRequest = [];
		}
	}

	function push(state) {
		if (!curRequest.includes(state)) {
			curRequest.push(state);
			checkingCurRequest.push(state);
			curRequest.forEach(otherState => {
				if (!has(completedPairs, [state, otherState])) {
					completedPairs.push([state, otherState]);
				}
			});
		}
	}

	states.forEach(s1 => {
		while (!states.every(
			s2 => s1 === s2 || has(completedPairs, [s1, s2]))) {

			push(s1);
			const addMe = unsort(states).find(
				s2 => s1 !== s2 &&
					!checkingCurRequest.some(
						s3 => has(completedPairs, [s2, s3])));
			if (addMe) {
				push(addMe);
				if (curRequest.length === 5) {
					finishRequest();
				}
			} else {
				checkingCurRequest = [s1];
			}
		}
		if (curRequest.length > 3) {
			finishRequest();
		}
	});

	finishRequest();
	return plan;

}

const efficientPlan = computeEfficientPlan();

console.log(`Efficient plan length: ${efficientPlan.length}`);
checkPlan(efficientPlan);

// it's not perfect, given that it changes based on the shuffling of the states
// in the inner loop, but it's consistently and significantly better than the
// naïve plan, usually getting lengths around 150 pairs! Remember our lower
// bound of 130. Once again, shuffling the inner loop produces measurably better
// plans than leaving the default order.

// Can we do better? How about not insisting that states are perfect, but rather
// selecting the state that will produce the greatest number of new pairs?

function computeEfficientPlanV2() {

	const plan = [];
	const completedPairs = [];
	let curRequest = [];

	function finishRequest() {
		if (curRequest.length > 0) {
			plan.push(curRequest);
			curRequest = [];
		}
	}

	function push(state) {
		if (!curRequest.includes(state)) {
			curRequest.push(state);
			curRequest.forEach(otherState => {
				if (!has(completedPairs, [state, otherState]) && state !== otherState) {
					completedPairs.push([state, otherState]);
				}
			});
		}
	}

	while (completedPairs.length < 1225) {
		const addMe = states
			  .filter(s1 => !curRequest.includes(s1))
			  .map(s1 =>
				   ({state: s1,
					 newPairs: curRequest.filter(
						 s2 => !has(completedPairs, [s1, s2])
					 ).length,
					 existingPairs: completedPairs.filter(
						 cp => cp[0] === s1 || cp[1] === s1
					 ).length,
					}))
		// descending by newPairs, then ascending by existingPairs
			  .sort((s1, s2) =>
					(s2.newPairs - s1.newPairs)
					|| (s1.existingPairs - s2.existingPairs))
			  .map(s => s.state)[0];
		push(addMe);
		if (curRequest.length === 5) {
			finishRequest();
		}
	}

	finishRequest();
	return plan;

}

const efficientPlanV2 = computeEfficientPlanV2();

console.log(`Efficient plan V2 length: ${efficientPlanV2.length}`);
checkPlan(efficientPlanV2);

// Not really any better. The significant change is that we no longer have a
// "primary" state, instead we pick a new initial state for each group by
// picking the state with the fewest completed pairs, i.e, the most potential.
// The code is certainly the simplest. It also has about the same performance
// with or without shuffling the list.

// Enough theory, time for some practice!

if (fs.existsSync('state-trends.json')) {
	console.log('Found file state-trends.json, reading...');
	const pairData = JSON.parse(fs.readFileSync('state-trends.json', 'utf-8'));
	printPairs(pairData, 10);
} else {
	console.log('No JSON file found on disk, making requests to Google...');

	evaluatePlan(efficientPlanV2).then(pairData => {
		console.log('Writing JSON to disk...');
		fs.writeFileSync('state-trends.json', JSON.stringify(pairData), 'utf-8');
		console.log('Results:');
		printPairs(pairData, 10);
	});
}

// returns a list of pairs found from the group
async function request(group) {
	console.error(`Requesting group: ${group}`);
	const result = [];
	let rawResult;
	try {
		rawResult = await gt.interestByRegion({keyword: group, geo: 'US'});
	} catch (e) {
		console.log('Error, waiting and retrying...');
		await sleep(15000);
		return request(group);
	}
	group.forEach((state, i) => {
		const value = JSON.parse(rawResult).default.geoMapData
			  .find(g => g.geoName === state)
			  .value;
		for (let k = 0; k < group.length; k++) {
			if (k === i) {
				continue;
			}
			result.push({self: state, other: group[k],
						 selfSearches: value[i], otherSearches: value[k]});
		}
	});
	return result;
}

// returns a list of all pairs
async function evaluatePlan(plan) {
	const result = [];
	for (let i = 0; i < plan.length; i++) {
		const res = await request(plan[i]);
		res.forEach(p => result.push(p));
	}
	return result;
}

// you will often see pairs of the same two cities in the results, because the
// same pair is included in multiple groups, but because of the portions of the
// other states it will have slightly different numbers each time.
function printPairs(pairs, num) {
	console.log(
		pairs
			.map(p => Object.assign({diff: p.otherSearches - p.selfSearches}, p))
			.sort((p1, p2) => p2.diff - p1.diff)
			.slice(0, num));
}
