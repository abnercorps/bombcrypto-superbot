import { ObjectHeaderItem } from "csv-writer/src/lib/record";
import got from "got";
import { Context, Telegraf } from "telegraf";
import { Client } from "./api";
import { VERSION_CODE } from "./constants";
import { getFromCsv, getRandomArbitrary, sleep, writeCsv } from "./lib";
import { logger } from "./logger";
import { default as version } from "./version.json";

import {
    BLOCK_TYPE_MAP,
    buildBlock,
    buildHero,
    buildHouse,
    Hero,
    House,
    IGetBlockMapPayload,
    IHeroUpdateParams,
    IMapTile,
    IMapTileEmpty,
    Squad,
    TreasureMap,
} from "./model";
import {
    IEnemies,
    IEnemyTakeDamagePayload,
    IGetActiveBomberPayload,
    isFloat,
    IStartExplodePayload,
    IStartStoryExplodePayload,
    IStoryMap,
    ISyncBombermanPayload,
    parseGetActiveBomberPayload,
    parseGetBlockMapPayload,
    parseHeroStats,
    parseStartExplodePayload,
    parseSyncHousePayload,
} from "./parsers";
import { ILoginParams } from "./parsers/login";
import { makeException } from "./err";

const DEFAULT_TIMEOUT = 1000 * 60 * 5;
const HISTORY_SIZE = 5;
const ADVENTURE_ENABLED = true;

type ExplosionByHero = Map<
    number,
    {
        timestamp: number;
        tile: IMapTile;
    }
>;
type NotificationShieldHero = Map<
    number,
    {
        timestamp: number;
    }
>;
type LocationByHeroWorking = Map<
    number,
    {
        damage: number;
        tile: IMapTileEmpty;
    }
>;
type HeroBombs = { lastId: number; ids: number[] };

interface IMoreOptions {
    telegramKey?: string;
    forceExit?: boolean;
    modeAmazon?: boolean;
    modeAdventure?: boolean;
    saveRewardsCsv?: boolean;
    minHeroEnergyPercentage?: number;
    houseHeroes?: string;
    adventureHeroes?: string;
    rede?: string;
    version?: number;
    alertShield?: number;
    numHeroWork?: number;
    telegramChatId?: string;
}

const TELEGRAF_COMMANDS = ["rewards", "exit", "stats"] as const;

type ETelegrafCommand = typeof TELEGRAF_COMMANDS[number];

export class TreasureMapBot {
    public client!: Client;
    public map!: TreasureMap;
    public squad!: Squad;
    private telegraf?: Telegraf;
    private selection: Hero[];
    public houses: House[];
    private explosionByHero: ExplosionByHero;
    private notificationShieldHero: NotificationShieldHero;
    private locationByHeroWorking: LocationByHeroWorking;
    private heroBombs: Record<number, HeroBombs> = {};
    private history: IMapTile[];
    private index: number;
    private shouldRun: boolean;
    private lastAdventure: number;
    private alertShield: number;
    private forceExit = true;
    private minHeroEnergyPercentage;
    private modeAmazon = false;
    private modeAdventure = false;
    private saveRewardsCsv = false;
    private numHeroWork = 15;
    private adventureBlocks: IGetBlockMapPayload[] = [];
    private adventureEnemies: IEnemies[] = [];
    private houseHeroes: string[] = [];
    private adventureHeroes: string[] = [];
    private playing: "Adventure" | "Amazon" | "Treasure" | "sleep" | null =
        null;
    public params: IMoreOptions;

    constructor(loginParams: ILoginParams, moreParams: IMoreOptions) {
        const {
            forceExit = true,
            minHeroEnergyPercentage = 90,
            modeAmazon = false,
            houseHeroes = "",
            adventureHeroes = "",
            modeAdventure = false,
            saveRewardsCsv = false,
            rede = "BSC",
            version = VERSION_CODE,
            alertShield = 0,
            numHeroWork = 15,
        } = moreParams;

        this.params = moreParams;
        loginParams.rede = rede;
        loginParams.version = version;

        this.modeAdventure = modeAdventure;
        this.modeAmazon = true;
        this.saveRewardsCsv = saveRewardsCsv;
        this.playing = null;
        this.numHeroWork = numHeroWork;
        this.client = new Client(loginParams, DEFAULT_TIMEOUT, modeAmazon);
        this.map = new TreasureMap({ blocks: [] });
        this.squad = new Squad({ heroes: [] });
        this.houses = [];
        this.forceExit = forceExit || true;
        this.houseHeroes = houseHeroes ? houseHeroes.split(":") : [];
        this.adventureHeroes = adventureHeroes
            ? adventureHeroes.split(":")
            : [];
        this.minHeroEnergyPercentage = minHeroEnergyPercentage;

        this.explosionByHero = new Map();
        this.heroBombs = {};
        this.locationByHeroWorking = new Map();
        this.notificationShieldHero = new Map();
        this.selection = [];
        this.history = [];
        this.index = 0;
        this.shouldRun = false;
        this.lastAdventure = 0;
        this.alertShield = alertShield;
    }

    async stop() {
        logger.info("Send sleeping heros...");
        this.shouldRun = false;

        await sleep(5000);

        for (const hero of this.workingSelection) {
            await this.client.goSleep(hero);
        }

        if (this.telegraf) {
            this.telegraf.stop();
        }
    }

    async initTelegraf(telegramKey: string) {
        logger.info("Starting telegraf...");
        this.telegraf = new Telegraf(telegramKey);
        process.once("SIGINT", () => this.telegraf?.stop("SIGINT"));
        process.once("SIGTERM", () => this.telegraf?.stop("SIGTERM"));

        TELEGRAF_COMMANDS.forEach((command) =>
            this.telegraf?.command(
                command,
                this.handleTelegraf.bind(this, command)
            )
        );

        await this.telegraf.launch();
    }

    async sendMessageChat(message: string) {
        if (!this.params.telegramChatId) return;

        return this.telegraf?.telegram.sendMessage(
            this.params.telegramChatId,
            message
        );
    }

    getStatusPlaying() {
        if (this.playing === "sleep") return "sleep for 10 seconds";
        if (this.playing === null) return "starting";
        return this.playing;
    }

    public async getStatsAccount() {
        const formatMsg = (hero: Hero) => {
            const isSelectedAtHome = this.houseHeroes.includes(
                hero.id.toString()
            );
            const shield = hero.shields?.length
                ? `${hero.shields[0].current}/${hero.shields[0].total}`
                : "empty shield";
            if (isSelectedAtHome) {
                return `<b>${hero.rarity} [${hero.id}]: ${hero.energy}/${hero.maxEnergy} | ${shield}</b>`;
            } else {
                return `${hero.rarity} [${hero.id}]: ${hero.energy}/${hero.maxEnergy} | ${shield}`;
            }
        };

        // const heroesAdventure = await this.getHeroesAdventure();

        const workingHeroesLife = this.workingSelection
            .map(formatMsg)
            .join("\n");
        const notWorkingHeroesLife = this.sleepingSelection
            .map(formatMsg)
            .join("\n");
        const homeHeroesLife = this.homeSelection.map(formatMsg).join("\n");
        let msgEnemies = "\n";

        if (this.playing === "Adventure") {
            const enemies = this.adventureEnemies.filter(
                (e) => e.hp > 0
            ).length;
            const AllEnemies = this.adventureEnemies.length;
            msgEnemies = `Total enemies adventure: ${enemies}/${AllEnemies}\n\n`;
        }
        // const heroesAdventureSelected = this.adventureHeroes.join(", ");
        const houseHeroesIds = this.houseHeroes.join(", ");

        const message =
            `Playing mode: ${this.getStatusPlaying()}\n\n` +
            // `Adventure heroes: ${heroesAdventure.usedHeroes.length}/${heroesAdventure.allHeroes.length}\n` +
            // `Heroes selected for adventure: ${heroesAdventureSelected}\n` +
            msgEnemies +
            `Network: ${this.client.loginParams.rede}\n` +
            `Treasure/Amazon:\n` +
            `${this.map.toString()}\n` +
            `Heroes selected for home(${this.houseHeroes.length}): ${houseHeroesIds}\n` +
            `Remaining chest (Amazon): \n${this.map
                .formatMsgBlock()
                .join("\n")}\n\n` +
            `INFO: LIFE HERO | SHIELD HERO\n` +
            `Working heroes (${this.workingSelection.length}): \n${workingHeroesLife}\n\n` +
            `Resting heroes (${this.sleepingSelection.length}): \n${notWorkingHeroesLife}\n\n` +
            `Resting heroes at home (${this.homeSelection.length}): \n${homeHeroesLife}`;

        return message;
    }

    public async getRewardAccount() {
        if (this.client.isConnected) {
            const rewards = await this.client.getReward();
            // const detail = await this.client.coinDetail();

            const message =
                "Rewards:\n" +
                // `Mined: ${detail.mined} | Invested: ${detail.invested} ` +
                // `| Rewards: ${detail.rewards}\n` +
                rewards
                    .sort((a, b) => (a.network > b.network ? -1 : 1))
                    .map(
                        (reward) =>
                            `${reward.network}-${reward.type}: ${
                                isFloat(reward.value)
                                    ? reward.value.toFixed(2)
                                    : reward.value
                            }`
                    )
                    .join("\n");

            return message;
        } else {
            throw new Error("Not connected, please wait");
        }
    }

    public async handleTelegraf(command: ETelegrafCommand, context: Context) {
        logger.info(`Running command ${command} from ${context.from?.id}.`);

        const now = Date.now() / 1000;
        const timedelta = now - (context.message?.date || 0);

        if (timedelta >= 30) {
            logger.info(`Ignoring message ${context.message?.message_id}`);
            return;
        }

        if (command === "exit") {
            await context.reply("Exiting in 5 seconds...");
            this.shouldRun = false;
            await this.telegraf?.stop();
            await sleep(10000);
            if (this.forceExit) {
                process.exit(0);
            }
        } else if (command === "rewards") {
            try {
                const message = await this.getRewardAccount();
                await context.reply(message);
            } catch (e) {
                await context.reply("Not connected, please wait");
            }
        } else if (command === "stats") {
            const message = await this.getStatsAccount();
            await context.replyWithHTML(message);
        } else {
            await context.reply("Command not implemented");
        }
    }

    get workingSelection() {
        return this.selection.filter(
            (hero) => hero.state === "Work" && hero.energy > 0
        );
    }
    get notWorkingSelection() {
        return this.squad.notWorking;
    }
    get sleepingSelection() {
        return this.squad.sleeping;
    }
    get homeSelection() {
        return this.squad.home;
    }

    get home(): House | undefined {
        return this.houses.filter((house) => house.active)[0];
    }

    get homeSlots() {
        return this.home?.slots || 0;
    }

    nextId() {
        return this.index++;
    }

    nextHero() {
        return this.workingSelection[
            this.nextId() % this.workingSelection.length
        ];
    }

    async logIn() {
        if (this.client.isLoggedIn) return;
        logger.info("Logging in...");

        await this.client.connectServer();
        this.reset();
        await this.client.login();
        logger.info("Logged in successfully");
        await this.saveRewards();
    }

    async saveRewards() {
        if (!this.saveRewardsCsv) return;
        logger.info("Save rewards in csv...");
        let user = "nameuser";
        if ("username" in this.client.loginParams) {
            user = this.client.loginParams.username;
        } else if ("wallet" in this.client.loginParams) {
            user = this.client.loginParams.wallet;
        }
        const name = `./csv/${user}.csv`;
        const rewards = await this.client.getReward();

        const items = await getFromCsv(name);
        const headers: ObjectHeaderItem[] = [];
        const obj: Record<string, string> = {};

        rewards.map((reward) => {
            const type = reward.type as string;
            obj[type] = reward.value.toString();
            headers.push({ id: type, title: type });
        });

        items.push(obj);

        await writeCsv(name, items, headers);
    }

    async refreshHeroAtHome() {
        const homeSelection = this.squad.notWorking
            .filter(
                (hero) =>
                    !this.modeAmazon ||
                    (this.modeAmazon &&
                        hero.shields &&
                        hero.shields.length &&
                        this.getSumShield(hero))
            )
            .sort(
                (a, b) =>
                    +this.houseHeroes.includes(b.id.toString()) -
                        +this.houseHeroes.includes(a.id.toString()) ||
                    b.rarityIndex - a.rarityIndex
            )
            .slice(0, this.homeSlots);

        logger.info(`Will send heroes home (${this.homeSlots} slots)`);

        for (const hero of homeSelection) {
            if (hero.state === "Home") continue;

            const atHome = this.squad.byState("Home");

            if (
                this.houseHeroes.includes(hero.id.toString()) ||
                atHome.length < this.homeSlots
            ) {
                if (atHome.length < this.homeSlots) {
                    logger.info(`Sending hero ${hero.id} home`);
                    await this.client.goHome(hero);
                } else {
                    const removeHero = atHome.find(
                        (hero) => !this.houseHeroes.includes(hero.id.toString())
                    );

                    if (removeHero) {
                        logger.info(`Removing hero ${removeHero.id} from home`);
                        await this.client.goSleep(removeHero);
                        logger.info(`Sending hero ${hero.id} home`);
                        await this.client.goHome(hero);
                    }
                }
            }
        }
    }

    getSumShield(hero: Hero) {
        return (
            hero.shields
                ?.map((hero) => hero.current)
                .reduce((p, r) => p + r, 0) || 0
        );
    }

    alertShieldHero(hero: Hero) {
        this.sendMessageChat(`Hero ${hero.id} needs shield repair`);
        logger.info(`Hero ${hero.id} needs shield repair`);
    }

    async refreshHeroSelection() {
        logger.info("Refreshing heroes");
        await this.client.getActiveHeroes();

        this.selection = this.squad.byState("Work");
        const heroes = this.squad.notWorking.sort((a, b) => {
            const apercent = (a.energy / a.maxEnergy) * 100;
            const bpercent = (b.energy / b.maxEnergy) * 100;

            return bpercent - apercent;
        });
        for (const hero of heroes) {
            const percent = (hero.energy / hero.maxEnergy) * 100;
            if (percent < this.minHeroEnergyPercentage) continue;

            if (
                this.modeAmazon &&
                (!hero.shields ||
                    hero.shields.length === 0 ||
                    this.getSumShield(hero) <= this.alertShield)
            ) {
                const lastDate = this.notificationShieldHero.get(
                    hero.id
                )?.timestamp;
                //verifica se faz mais que 24 horas da ultima notificação
                if (
                    !lastDate ||
                    (lastDate &&
                        Math.abs(
                            new Date(lastDate).getTime() - new Date().getTime()
                        ) / 36e5) > 24
                ) {
                    this.alertShieldHero(hero);
                    this.notificationShieldHero.set(hero.id, {
                        timestamp: new Date().getTime(),
                    });
                }
                if (
                    !hero.shields ||
                    hero.shields.length === 0 ||
                    this.getSumShield(hero) === 0
                ) {
                    continue;
                }
            }

            if (this.workingSelection.length <= this.numHeroWork - 1) {
                logger.info(`Sending hero ${hero.id} to work`);
                await this.client.goWork(hero);
                this.selection.push(hero);
            }
        }

        logger.info(`Sent ${this.selection.length} heroes to work`);

        await this.refreshHeroAtHome();
    }

    async refreshMap() {
        logger.info(`Refreshing map...`);
        if (this.map.totalLife <= 0) {
            this.resetState();
            logger.info(JSON.stringify(await this.client.getReward()));
        }
        await this.client.getBlockMap();
        logger.info(`Current map state: ${this.map.toString()}`);
    }

    nextLocation(hero: Hero) {
        //verifica se ele ja esta jogando a bomba em um local.
        const result = this.locationByHeroWorking.get(hero.id);
        const location = this.map
            .getHeroDamageForMap(hero)
            .find(
                ({ tile }) =>
                    tile.i == result?.tile.i && tile.j == result?.tile.j
            );

        if (result && location && location.damage > 0) {
            return result;
        }
        const locations = this.map
            .getHeroDamageForMap(hero)
            .filter(({ damage }) => damage > 0);

        let selected;

        if (locations.length <= HISTORY_SIZE) {
            selected = locations[0];
        } else {
            const items = locations.filter(
                ({ tile: option }) =>
                    !this.history.find(
                        (tile) => tile.i === option.i && tile.j === option.j
                    )
            );
            selected = items[0];
            //random
            //selected = items[Math.floor(Math.random() * items.length)];
        }
        if (!selected) {
            selected = locations[0];
        }

        this.locationByHeroWorking.set(hero.id, selected);
        return selected;
    }

    canPlaceBomb(hero: Hero, location: IMapTile) {
        const entry = this.explosionByHero.get(hero.id);
        if (!entry) return true;

        const distance =
            Math.abs(location.i - entry.tile.i) +
            Math.abs(location.j - entry.tile.j);

        const timedelta = (distance / hero.speed) * 500;
        const elapsed = Date.now() - entry.timestamp;

        const bombs = this.heroBombs[hero.id]?.ids.length || 0;

        return elapsed >= timedelta && bombs < hero.capacity;
    }

    removeBombHero(hero: Hero, bombId: number) {
        if (!(hero.id in this.heroBombs)) {
            this.heroBombs[hero.id] = { ids: [], lastId: 0 };
        }

        const bombsByHero = this.heroBombs[hero.id];

        this.heroBombs[hero.id].ids = bombsByHero.ids.filter(
            (b) => b !== bombId
        );
    }

    addBombHero(hero: Hero) {
        if (!(hero.id in this.heroBombs)) {
            this.heroBombs[hero.id] = { ids: [], lastId: 0 };
        }

        const bombsByHero = this.heroBombs[hero.id];

        bombsByHero.lastId++;

        if (bombsByHero.lastId > hero.capacity) {
            bombsByHero.lastId = 1;
        }

        bombsByHero.ids.push(bombsByHero.lastId);
        return bombsByHero;
    }

    async placeBomb(hero: Hero, location: IMapTile) {
        const bombIdObj = this.addBombHero(hero);
        this.locationByHeroWorking.delete(hero.id);
        this.explosionByHero.set(hero.id, {
            timestamp: Date.now(),
            tile: location,
        });

        this.nextLocation(hero);
        if (!bombIdObj) {
            return false;
        }

        const bombId = bombIdObj.lastId;
        //seeta quantas bombas esta jogando ao mesmo tempo

        this.history.push(location);

        logger.info(
            `${hero.rarity} ${hero.id} ${hero.energy}/${hero.maxEnergy} will place ` +
                `bomb on (${location.i}, ${location.j})`
        );
        // await sleep(3000);
        const method = this.modeAmazon ? "startExplodeV2" : "startExplode";
        const result = await this.client[method]({
            heroId: hero.id,
            bombId,
            hero_type: hero.heroType,
            blocks: [],
            i: location.i,
            j: location.j,
        });

        this.removeBombHero(hero, bombId);

        if (!result) {
            return false;
        }

        const { energy } = result;

        while (this.history.length > HISTORY_SIZE) this.history.shift();

        if (energy <= 0) {
            logger.info(`Sending hero ${hero.id} to sleep`);
            await this.client.goSleep(hero);
            await this.refreshHeroSelection();
            await this.refreshHeroAtHome();
        }

        // logger.info(this.map.toString());
    }

    async placeBombsHero(hero: Hero) {
        const location = this.nextLocation(hero);

        if (location && this.canPlaceBomb(hero, location.tile)) {
            await this.placeBomb(hero, location.tile);
        }
    }

    async placeBombs() {
        const running: Record<number, Hero> = {};
        const promises = [];

        while (
            this.map.totalLife > 0 &&
            this.workingSelection.length > 0 &&
            this.shouldRun
        ) {
            for (const hero of this.workingSelection) {
                await sleep(70);

                running[hero.id] = hero;
                const promise = this.placeBombsHero(hero).catch((e) => {
                    throw e;
                });
                promises.push(promise);
            }
        }

        await Promise.all(promises);
    }

    async getHeroesAdventure() {
        const [allHeroes, details] = await Promise.all([
            this.client.syncBomberman(),
            this.client.getStoryDetails(),
        ]);

        const usedHeroes = details.played_bombers.map((hero) => hero.id);

        return {
            allHeroes,
            usedHeroes,
        };
    }

    async getHeroAdventure(allHeroes: ISyncBombermanPayload[]) {
        const details = await this.client.getStoryDetails();
        const usedHeroes = details.played_bombers.map((hero) => hero.id);
        const hero = allHeroes.find(
            (hero) =>
                !usedHeroes.includes(hero.id) &&
                (this.adventureHeroes.length == 0 ||
                    this.adventureHeroes.includes(hero.id.toString()))
        );

        if (!hero) {
            return null;
        }
        return buildHero({
            id: hero.id,
            energy: hero.energy,
            active: true,
            heroType: hero.heroType,
            state: "Sleep",
            ...parseHeroStats(hero.gen_id),
        });
    }

    getBlockAdventure() {
        const items = this.adventureBlocks;
        return items[Math.floor(Math.random() * items.length)];
    }
    getEnemyAdventure() {
        const items = this.adventureEnemies.filter((enemy) => enemy.hp > 0);
        return items[Math.floor(Math.random() * items.length)];
    }
    getRandomPosition(
        hero: Hero,
        map: IStoryMap,
        retry = 0
    ): { i: number; j: number } {
        retry = retry + 1;
        const i = Math.ceil(getRandomArbitrary(0, 28));
        const j = Math.ceil(getRandomArbitrary(0, 10));

        const doorI = map.door_x;
        const doorJ = map.door_y;

        const checkPosition = (i: number, j: number) => {
            return (
                (doorI < i - hero.range || doorI > i + hero.range) &&
                (doorJ < j - hero.range || doorJ > j + hero.range)
            );
        };

        if (checkPosition(i, j)) {
            return { i, j };
        }

        if (retry >= 100) {
            const retryPositions = [
                { i: 0, j: 0 },
                { i: 0, j: 10 },
                { i: 28, j: 0 },
                { i: 28, j: 10 },
            ];
            for (const position of retryPositions) {
                if (checkPosition(position.i, position.j)) {
                    return position;
                }
            }

            return { i, j };
        }

        return this.getRandomPosition(hero, map, retry);
    }

    async placebombAdventure(
        hero: Hero,
        block: IGetBlockMapPayload | { i: number; j: number },
        map: IStoryMap,
        enemy?: IEnemies
    ) {
        const blockParse = block ? block : this.getRandomPosition(hero, map, 0);

        logger.info(
            `[${hero.rarity}] damage: ${hero.damage} ${hero.id} will place bomb on (${blockParse.i}, ${blockParse.j})`
        );
        const startExplode = this.client.startStoryExplode({
            heroId: hero.id,
            hero_type: hero.heroType,
            i: blockParse.i,
            j: blockParse.j,
            blocks: [],
            bombId: 0,
            isHero: true,
        });

        if (enemy) {
            const totalEnemies = this.adventureEnemies.filter(
                (enemy) => enemy.hp > 0
            );
            logger.info(
                `${hero.id} will place bomb in enemy ${enemy.id} ${enemy.hp}/${enemy.maxHp} totalEnemies ${totalEnemies.length}`
            );
            const enemyTakeDamage = this.client.enemyTakeDamage({
                enemyId: enemy.id,
                heroId: hero.id,
            });
            return await Promise.all([startExplode, enemyTakeDamage]);
        }

        return await startExplode;
    }

    async placeBombsAdventure(hero: Hero, map: IStoryMap) {
        let enemy;
        while ((enemy = this.getEnemyAdventure()) && this.shouldRun) {
            const block = this.getBlockAdventure();

            await this.placebombAdventure(hero, block, map, enemy);

            await sleep(getRandomArbitrary(4, 9) * 1000);
        }
        return true;
    }

    async adventure() {
        if (!ADVENTURE_ENABLED) return null;
        const allHeroes = await this.client.syncBomberman();

        if (allHeroes.length < 15) return null;

        const rewards = await this.client.getReward();
        const keys = rewards.filter((reward) => reward.type === "Key")[0];

        logger.info(`Adventure mode iteration`);

        if (!keys || keys.value === 0) {
            logger.info(`No keys to play right now.`);
            return;
        }
        logger.info(`${keys.value} keys mode adventure`);

        const details = await this.client.getStoryDetails();
        const hero = await this.getHeroAdventure(allHeroes);
        if (hero) {
            const level = Math.min(details.max_level + 1, 45);

            logger.info(`Will play level ${level} with hero ${hero.id}`);

            const result = await this.client.getStoryMap(hero.id, level);
            this.adventureBlocks = result.positions;
            this.adventureEnemies = result.enemies;
            logger.info(`Total enemies: ${this.adventureEnemies.length}`);

            await this.placeBombsAdventure(hero, result);
            logger.info(
                `Place bomb in door x:${result.door_x} y:${result.door_y}`
            );
            await this.placebombAdventure(
                hero,
                {
                    i: result.door_x,
                    j: result.door_y,
                },
                result
            ); //placebomb door

            logger.info(
                `total enemies after door: ${
                    this.adventureEnemies.filter((enemy) => enemy.hp > 0).length
                }`
            );
            await this.placeBombsAdventure(hero, result); //verifica se tem mais enimies

            if (!this.shouldRun) return false;
            logger.info(`Enter door adventure mode`);
            const resultDoor = await this.client.enterDoor();

            logger.info(`Finished Adventure mode ${resultDoor.rewards} Bcoin`);
        } else {
            logger.info(`No hero Adventure mode`);
        }
    }

    async loadHouses() {
        const payloads = await this.client.syncHouse();
        this.houses = payloads.map(parseSyncHousePayload).map(buildHouse);
    }

    async sleepAllHeroes() {
        logger.info("Sleep all heroes...");
        for (const hero of this.workingSelection) {
            await this.client.goSleep(hero);
        }
    }

    sendPing() {
        setInterval(() => this.client.ping(), 1000 * 10);
    }
    async checkUpdate() {
        await this.checkVersion();
        setInterval(() => this.checkVersion(), 1000 * 60);
    }

    async loop() {
        console.log(this.params.version);
        if (this.params.telegramKey) {
            await this.initTelegraf(this.params.telegramKey);
        }
        await this.checkUpdate();
        this.shouldRun = true;

        return;
        await this.logIn();
        this.sendPing();
        await this.loadHouses();
        await this.refreshMap();

        do {
            if (this.map.totalLife <= 0) await this.refreshMap();

            logger.info("Opening map...");
            this.playing = this.modeAmazon ? "Amazon" : "Treasure";
            await this.client.startPVE(0, this.modeAmazon);

            await this.refreshHeroSelection();
            await this.placeBombs();
            await this.sleepAllHeroes();
            await this.refreshHeroAtHome();

            logger.info("Closing map...");
            await this.client.stopPVE();
            logger.info("There are no heroes to work now.");

            if (
                (Date.now() > this.lastAdventure + 10 * 60 * 1000 ||
                    this.lastAdventure === 0) &&
                this.modeAdventure
            ) {
                this.resetStateAdventure();
                this.playing = "Adventure";

                await this.adventure();
                this.lastAdventure = Date.now();
            }
            this.playing = "sleep";
            logger.info("Will sleep for 10 seconds");
            await sleep(10 * 1000);
        } while (this.shouldRun);
    }

    private resetState() {
        this.history = [];
        this.explosionByHero = new Map();
        this.heroBombs = {};
        this.locationByHeroWorking = new Map();
        this.selection = [];
        this.index = 0;
    }
    private resetStateAdventure() {
        this.adventureBlocks = [];
        this.adventureEnemies = [];
    }

    reset() {
        this.client.wipe();

        this.client.on({
            event: "getBlockMap",
            handler: this.handleMapLoad.bind(this),
        });

        this.client.on({
            event: "getActiveBomber",
            handler: this.handleSquadLoad.bind(this),
        });

        this.client.on({
            event: "goSleep",
            handler: this.handleHeroSleep.bind(this),
        });

        this.client.on({
            event: "goHome",
            handler: this.handleHeroHome.bind(this),
        });

        this.client.on({
            event: "goWork",
            handler: this.handleHeroWork.bind(this),
        });

        this.client.on({
            event: "startExplode",
            handler: this.handleExplosion.bind(this),
        });
        this.client.on({
            event: "startExplodeV2",
            handler: this.handleExplosion.bind(this),
        });
        this.client.on({
            event: "startStoryExplode",
            handler: this.handleStartStoryExplode.bind(this),
        });
        this.client.on({
            event: "enemyTakeDamage",
            handler: this.handleEnemyTakeDamage.bind(this),
        });

        this.resetState();
    }

    private handleMapLoad(payload: IGetBlockMapPayload[]) {
        const blocks = payload.map(parseGetBlockMapPayload).map(buildBlock);

        this.map.update({ blocks });
    }

    private handleSquadLoad(payload: IGetActiveBomberPayload[]) {
        const heroes = payload.map(parseGetActiveBomberPayload).map(buildHero);
        this.squad.update({ heroes });
    }

    private handleHeroSleep(params: IHeroUpdateParams) {
        this.squad.updateHeroEnergy(params);
        this.squad.updateHeroState(params.id, "Sleep");
    }

    private handleHeroHome(params: IHeroUpdateParams) {
        this.squad.updateHeroEnergy(params);
        this.squad.updateHeroState(params.id, "Home");
    }

    private handleHeroWork(params: IHeroUpdateParams) {
        this.squad.updateHeroEnergy(params);
        this.squad.updateHeroState(params.id, "Work");
    }

    notificationBlockCage() {
        logger.info("you won a hero");
    }

    private handleExplosion(payload: IStartExplodePayload) {
        const [mapParams, heroParams] = parseStartExplodePayload(payload);
        this.squad.updateHeroEnergy(heroParams);

        for (const block of mapParams) {
            const blockType = this.map.blocks.find(
                (b) => b.i == block.i && b.j == block.j
            );
            if (blockType?.type === BLOCK_TYPE_MAP[2] && block.hp === 0) {
                this.notificationBlockCage();
            }
        }
        mapParams.forEach((params) => this.map.updateBlock(params));
    }
    private handleStartStoryExplode(payload: IStartStoryExplodePayload) {
        if (payload.blocks.length) {
            //remove blocks from this.adventureblocks
            payload.blocks.forEach((block) => {
                this.adventureBlocks = this.adventureBlocks.filter(
                    (b) => b.i !== block.i || b.j !== block.j
                );
            });
        }
        if (payload.enemies && payload.enemies.length) {
            logger.info(`add enemies ${payload.enemies.length}`);
            payload.enemies.forEach((enemy) => {
                this.adventureEnemies.push(enemy);
            });
        }
    }
    private handleEnemyTakeDamage(payload: IEnemyTakeDamagePayload) {
        const enemy = this.adventureEnemies.find(
            (enemy) => enemy.id == payload.id
        );
        if (enemy) {
            enemy.hp = payload.hp;
        }
    }

    async checkVersion() {
        const currentVersion = await got
            .get(
                "https://raw.githubusercontent.com/lucasvieceli/bombcrypto-superbot/master/src/version.json",
                {
                    headers: {
                        "content-type": "application/json",
                    },
                }
            )
            .json<number>();
        if (currentVersion != version) {
            await this.sendMessageChat("Please update your code version");
            throw makeException("Version", `Please update your code version`);
        }
    }
}
