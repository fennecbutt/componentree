/**
 * @author Fennec Cooper
 * @email
 * @create date 2018-10-02 19:26:32
 * @modify date 2018-10-02 19:26:32
 * @desc [description]
*/

import glob from 'glob-promise';
import { map as mapAsync } from 'bluebird';

const pkg = require('../package.json');

export interface ComponentreeConfiguration {
    base?: string;
    debug?: boolean;
    errorHandler?: (e: any) => any;
}

export type Newable<T> = new (...args: any[]) => T;

export interface Component<T = any> extends Newable<T> {
    [key: string]: any;
    type?: string;
    service?: boolean;
    tags?: Set<string>;
    noinjects?: { index: number; resolver?: string; }[];
    initialisers?: string[];
}

export interface InternalComponentInstance {
    inits?: string[];
}

export interface ComponentContainer {
    component: Component;
    source: String | null;
}

type IndexedObject = { [key: string]: IndexedObject };

// NOTE do we always want to search fs for components or do we want to use a manifest system, or both?
// Could we search fs to load and build a manifest in dev and then use that manifest in prod? Probably a good idea
const defaultConfiguration = {
    base: 'c' // NOTE force base of c or override with componentree.json?
}

if (global.register === undefined) {
    global.register = (component: Component) => (global.earlyComponents || (global.earlyComponents = [])) && global.earlyComponents.push(component);
}

class CircularityError extends Error {
    constructor(public dependencyChain: string[]) {
        super();
    }
}

enum ParameterType {
    INJECTION,
    DATA
}

/**
 * Splits an array of items into an array of two arrays
 * Where the first array contains items that sortFn returned true for
 * and the second array contains items that sortFn returned false for
 * @param items
 * @param sortFn
 */
// function split<T>(items: T[], sortFn: (item: T) => boolean): [T[], T[]] {
//     return items.reduce<[T[], T[]]>((splitItems, item) => {
//         splitItems[sortFn(item) ? 1 : 0].push(item);
//         return splitItems;
//     }, [[], []]);
// }

async function findAsync<T, U= any>(items: T[], findFn: (item: T) => Promise<U>): Promise<U | undefined> {
    let item: T | undefined = undefined;
    for (let i = 0; i < items.length; i++) {
        const result = await findFn(items[i]);
        if (result) {
            return result;
        }
    }
    return undefined;
}

@service
export class Componentree {
    protected components: Map<string, ComponentContainer> = new Map([[Componentree.name, this.MakeComponentContainer(<Component>Componentree, __filename)]]);
    protected instances: any[] = [];
    protected services: Map<string, any> = new Map([[Componentree.name, this]]);
    protected parameterSources: Map<string, DataParameterSource> = new Map();

    constructor(@noinject() private config: ComponentreeConfiguration = defaultConfiguration) {
        this.Log(`🐾 Componentree version ${pkg.version}`);
        this.config = { ...defaultConfiguration, ...this.config };
        global.register = this.Register.bind(this);
        // console.log(`REBOUND register: ${global.register.toString()}`);
        (async () => {
            // 1 Load files
            this.Log(`Working directory: ${process.cwd()}`);
            const filesLoaded = (await glob(`**/*.${this.config.base}.js`, { symlinks: true })).map(file => {
                this.Log(`Loading ${file}`);
                require(`${process.cwd()}/${file}`);
                this.Log(`Loaded ${file}`);
            }).length;
            // 2 Validate injections and inits (checks they exist, checks for circularity/codependence)

            this.Log(`${global.earlyComponents.length} components were loaded early (${global.earlyComponents.map(c => c.name)})`);
            global.earlyComponents = global.earlyComponents.filter(component => this.Register(component));

            this.Log(`Loaded ${this.components.size} components from ${filesLoaded} files (${Array.from(this.components.keys())})`);
            // Need a better/cleaner method to do the following, just short on time to do it
            const circularityMessage = 'Circularity check';
            let circularityErrors: number = 0;
            this.components.forEach(componentContainer => {
                try {
                    this.GetInjectionTree(componentContainer.component);
                } catch (e) {
                    if (e instanceof CircularityError) {
                        // Log the error
                        ++circularityErrors;
                        this.Log(`Circular dependency chain: ${e.dependencyChain.join('->')}`);
                    } else {
                        throw e;
                    }
                }
            });
            if (circularityErrors === 0) this.Log(`${circularityMessage} succeeded`);
            else throw new Error(`${circularityMessage} failed with ${circularityErrors} error${circularityErrors === 1 ? '' : 's'}`);
            // Load and instantiate pipeline extensions
            await mapAsync(this.GetByInheritance(DataParameterSource), async component => {
                this.parameterSources.set(component.name, await this.GetInstance(component));
            });
            // 2 Instantiate services (ordered by inits)
            await mapAsync(Array.from(this.components.values()).filter(container => container.component.service), async container => {
                if (!this.services.has(container.component.name)) {
                    this.Log(`Starting service ${container.component.name}`);
                    this.services.set(container.component.name, await this.Inject(container.component));
                    this.Log(`Started service ${container.component.name}`);
                }
            }, {
                    concurrency: 1
                });
            // 3 Initialise services
        })().catch(e => {
            if (this.config.errorHandler instanceof Function) {
                this.config.errorHandler(e);
            }
            console.log(e);
            process.exit(1);
        });
    }
    // TODO default params break injection, componentree loops and keeps instantiating itself
    // protected GenerateManifest() {
    //     return Array.from(this.components).map(component => 0);
    // }

    /**
     * Builds and returns the tree of injections for a given component
     * Use a more efficient method/structure for this in the future! (Although it only runs on start-up anyways)
     */
    private GetInjectionTree(component: Component, dependencyChain?: string[]) {
        if (!dependencyChain) dependencyChain = [component.name]; // Create with parent as origin
        const injections = this.GetInjectionNames(component).filter(ij => ij.type === ParameterType.INJECTION).map(ij => ij.name);
        // Check for a collision with any members of the current injection set
        injections.forEach(name => {
            /**
             * Typescript, why can't you tell I'm checking and assigning to dependencyChain
             * like LITERALLY a couple of lines above?
             */
            if (dependencyChain!.indexOf(name) > -1) throw new CircularityError(dependencyChain!.concat(name));
        });
        // No errors with this set, so branch and check the injections of each of the subsequent ones
        return injections ? injections.reduce<IndexedObject>((p, c) => {
            p[c] = this.GetInjectionTree(this.SafelyGetComponent(c), Array.from(dependencyChain!).concat(c)); // Copy the array so each branch of injections isn't modifying the chain for the other
            return p;
        }, {}) : {};
    }

    protected Log(message: any, ...optionalParams: any[]) {
        if (this.config.debug) console.log(...arguments);
    }

    protected MakeComponentContainer(component: Component, source: String | null = null): ComponentContainer {
        return {
            component,
            source: source
        }
    }

    Register(component: Component, source: String | null = null) {
        // console.log(`REGISTER CALLED: ${component.name}`);
        this.components.set(component.name, this.MakeComponentContainer(<Component>component, source));
    }

    protected GetInjectionNames(t: Component) {
        // NOTE once the reflection stuff is working properly, we can switch to stringifying the constructor as a fallback
        const stringified = t.toString();
        if (stringified.indexOf(`class ${t.name}`) !== 0) throw new Error(`Component is not a class: ${JSON.stringify(t)}`);
        const matches = stringified.match(/constructor.*?\(([^)]*)\)/);
        const commentedOut = stringified.match(/\/\/\s*constructor\s*\(/);
        if ((!commentedOut || commentedOut.length === 0) && matches && matches.length === 2) {
            return matches[1].replace(/\s/g, '').split(',').map((n, i) => ({ name: n, type: (!t.noinjects || !t.noinjects.map(ni => ni.index).includes(i)) ? ParameterType.INJECTION : ParameterType.DATA })).filter(n => n.name.length > 0);
        } else return [];
    }

    protected async Inject<T, U={}>(t: Component, data?: U & { [key: string]: any }): Promise<T> {
        const instance = Reflect.construct(t, await mapAsync(this.GetInjectionNames(t), async (ij, i) => {
            if (ij.type === ParameterType.INJECTION) {
                /**
              * NOTE source tracking for components is implemented by the source property in
              * ComponentContainer, but I haven't thought of a good way of how to get it yet
              * since components autonomously register. For the moment the stack trace will suffice.
              */
                if (!this.components.has(ij.name)) throw new Error(`Could not find component: ${ij.name} in component ${t.name}`);
                if (this.components.get(ij.name)!.component.service) {
                    if (!this.services.get(ij.name)) this.services.set(ij.name, await this.Inject(this.components.get(ij.name)!.component));
                    return this.services.get(ij.name);
                } else {
                    return await this.Inject(this.components.get(ij.name)!.component);
                }
            } else if (ij.type === ParameterType.DATA) {
                let dataValue: any = undefined;

                // Get data source
                let source = t.noinjects ? t.noinjects.find(ni => ni.index === i) : null;

                if (source && source.resolver) {
                    if (!this.parameterSources.has(source.resolver)) {
                        throw new Error(`No data parameter source: ${source.resolver} for injection ${ij.name} of component ${t.name}`);
                    }
                    dataValue = await this.parameterSources.get(source.resolver)!.GetParameter(t, ij.name, i);
                } else if (data) {
                    dataValue = data[ij.name];
                }

                if (dataValue === undefined) {
                    throw new Error(`Could not locate data for injection ${ij.name} of component ${t.name}`);
                }

                return dataValue;
            } else {
                throw new Error(`Invalid ParameterType ${ij.type} for injection name ${ij.name}`);
            }
        }));
        if (t.initialisers) {
            this.Log(`Initialising ${t.name}`);
            await Promise.all(t.initialisers.map(initialiser => instance[initialiser]()));
            this.Log(`${t.name} initialised`);
        }
        return instance;
    }

    protected SafelyGetComponent(name: string, parent?: string) {
        if (!this.components.has(name)) throw new Error(`Could not find component: ${name} in ${parent || Componentree.name}`);
        return this.components.get(name)!.component;
    }

    public Get(name: string) {
        return this.SafelyGetComponent(name);
    }

    public GetInstance<T, U = {}>(component: Component<T>, data?: { [key: string]: any } & U): Promise<T> {
        return this.Inject<T>(component, data);
    }

    public GetByTags(...tags: string[]) {
        return Array.from(this.components.values()).filter(container => container.component.tags && container.component.tags.size !== 0 && tags.every(tag => container.component.tags!.has(tag)));
    }

    public GetByInheritance<T>(inherits: any, ...tags: string[]) {
        return <Component[]><unknown>Array.from(this.components.values()).filter(container => container.component.prototype instanceof inherits && (tags.length === 0 || container.component.tags && tags.every(tag => container.component.tags!.has(tag)))).map(container => container.component);
    }
}

// NOTE change all decorators to use a common metadata function, expose this to components to help them modify component metadata in a protected way
export function component(t: Component) {
    // console.log(`Registering component ${t.name}`);
    // console.log(`Bound register: ${global.register.toString()}`);
    t.type = 'component'
    global.register(t);
}

export function service(t: Component) {
    if (t.type !== 'component') component(t); // NOTE component here should be a string enum! (Or a string literal)
    t.service = true;
}

export function tag(...tags: string[]) {
    return (t: Component) => {
        (t.tags || (t.tags = new Set())) && (tags.forEach(tag => t.tags!.add(tag)));
    }
}

// NOTE for init of component a that requires components b and c that init, b and c init promises must be resolved before a init is called (makes sense!)
// What about multiple inits on a component? Just arbitrary order I guess, if we want a specific order use 1 init and branch from there
// What about arguments to these fns? Call with none, I suppose
export function initialiser(t: any, key: string, desc: PropertyDescriptor) { // NOTE figure out the specific type of a prototype (without forcing prototype constructor's type to Function...) so that we can ensure that this decorator is only used on async methods!
    // if(!t.service) throw new Error(`Component ${t.name} must be a service to use init`); // This doesn't seem great. Could we automatically make things that use init functions services?
    // service(t); // NOTE need a way to get access to this here. Need to detect problems as much as possible.
    // (t.inits || (t.inits = [])) && t.inits.push(key); // NOTE find a more elegant way of doing this
    // console.log(` keys ${t.constructor} lol ${t.abc} k ${key} desc ${JSON.stringify(desc)}`);
    (t.constructor.initialisers || (t.constructor.initialisers = [])) && t.constructor.initialisers.push(key);
}

export function noinject(source?: Component) {
    return (t: Component, key: string, index: number) => {
        // If key is undefined, assume the decorator is being called on the constructor (teeny bit of typescript weirdness)
        // Noinject is only built to work on constructor parameters (because we're not recording the index against a method name)
        if (key === undefined) (t.noinjects || (t.noinjects = [])) && t.noinjects.push({ index, resolver: source ? source.name : undefined });
    }
}

// export function extension(t: any, key: string, desc: PropertyDescriptor) { // NOTE figure out the specific type of a prototype (without forcing prototype constructor's type to Function...) so that we can ensure that this decorator is only used on async methods!
//     // if(!t.service) throw new Error(`Component ${t.name} must be a service to use init`); // This doesn't seem great. Could we automatically make things that use init functions services?
//     // service(t); // NOTE need a way to get access to this here. Need to detect problems as much as possible.
//     // (t.inits || (t.inits = [])) && t.inits.push(key); // NOTE find a more elegant way of doing this
//     // console.log(` keys ${t.constructor} lol ${t.abc} k ${key} desc ${JSON.stringify(desc)}`);
//     (t.constructor.initialisers || (t.constructor.initialisers = [])) && t.constructor.initialisers.push(key);
// }

// export interface InjectionPipelineExtension {
//     CanProvideDataParameter(component: Component, parameterName: string): boolean;
//     DataParameterSource?(component: Component, parameterName: string): Promise<any>;
// }
// export abstract class InjectionPipelineExtension {

// }

export abstract class DataParameterSource {
    abstract GetParameter(component: Component, parameterName: string, parameterIndex: number): Promise<any>;
}

// For init, load order needs to be changed
// Load
// Check inits are all satisfied
// Instantiate services
// Resolve init chains

// What about inits not being used on services? Ie not during startup. Services are restricted to singletons at the moment, what if we wanted
// To use init on a non-singleton component
// ^ That would still work fine...