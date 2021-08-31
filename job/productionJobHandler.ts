import { IConfig } from "config";
import { IJob } from "../entities/job";
import { AuthorizationError, InvalidJobError } from "../errors/errors";
import { JobRepository } from "../repositories/jobRepository";
import { ICDNConnector } from "../services/cdn";
import { CommandExecutorResponse, IJobCommandExecutor } from "../services/commandExecutor";
import { IFileSystemServices } from "../services/fileServices";
import { IJobRepoLogger } from "../services/logger";
import { IRepoConnector } from "../services/repo";
import { JobHandler } from "./jobHandler";

export class ProductionJobHandler extends JobHandler {

    constructor(job: IJob, config: IConfig, jobRepository: JobRepository, fileSystemServices: IFileSystemServices, commandExecutor: IJobCommandExecutor,
        cdnConnector: ICDNConnector, repoConnector: IRepoConnector, logger: IJobRepoLogger) {
        super(job, config, jobRepository, fileSystemServices, commandExecutor, cdnConnector, repoConnector, logger);
        this.name = "Production";
    }
    prepDeployCommands(): void {
        this.currJob.deployCommands = [
            '. /venv/bin/activate',
            `cd repos/${this.currJob.payload.repoName}`,
            'make publish && make deploy'
        ];

        if (this.currJob.payload.isNextGen) {
            const manifestPrefix = this.currJob.payload.manifestPrefix;
            this.currJob.deployCommands[this.currJob.deployCommands.length - 1] = `make next-gen-deploy MUT_PREFIX=${this.currJob.payload.mutPrefix}`;
            if (manifestPrefix) {
                this.currJob.deployCommands[this.currJob.deployCommands.length - 1] += ` MANIFEST_PREFIX=${manifestPrefix} GLOBAL_SEARCH_FLAG=${this.currJob.payload.stableBranch}`;
            }
        }
    }

    prepStageSpecificNextGenCommands(): void {
        this.prepBuildCommands();
        if (this.currJob.buildCommands) {
            this.currJob.buildCommands[this.currJob.buildCommands.length - 1] = 'make get-build-dependencies';
            this.currJob.buildCommands.push('make next-gen-html');
        }
    }

    async constructManifestIndexPath(): Promise<void> {
        try {
            const snootyName = await this.commandExecutor.getSnootyProjectName(this.currJob.payload.repoName);
            this.currJob.payload.manifestPrefix = snootyName + '-' + (this.currJob.payload.alias ? this.currJob.payload.alias : this.currJob.payload.branchName)
        } catch (error) {
            this.logger.save(this.currJob._id, error)
            throw error
        }
    }

    async getPathPrefix(): Promise<string> {
        try {
            let pathPrefix = ""
            if (this.currJob.payload.publishedBranches && this.currJob.payload.publishedBranches.version.active.length > 1) {
                pathPrefix = `${this.currJob.payload.publishedBranches.prefix}/${this.currJob.payload.alias ? this.currJob.payload.alias : this.currJob.payload.branchName}`;
            }
            else {
                pathPrefix = `${this.currJob.payload.alias ? this.currJob.payload.alias : this.currJob.payload.publishedBranches.content.prefix}`;
            }
            return pathPrefix;
        } catch (error) {
            this.logger.save(this.currJob._id, error)
            throw new InvalidJobError(error.message)
        }
    }

    private throwIfItIsNotPublishable(): void {
        const publishedBranches = this.currJob.payload.publishedBranches.git.branches.published;
        this.currJob.payload["stableBranch"] = (this.currJob.payload.publishedBranches.content.version.stable === this.currJob.payload.branchName && (this.currJob.payload.primaryAlias || !this.currJob.payload.aliased)) ? '-g' : "";
        if (!publishedBranches.includes(this.currJob.payload.branchName)) {
            this.logger.save(this.currJob._id, `${'(BUILD)'.padEnd(15)} You are trying to run in production a branch that is not configured for publishing`);
            throw new AuthorizationError(`${this.currJob.payload.branchName} is not configured for publish`);
        }
    }

    private async purgePublishedContent(makefileOutput: Array<string>): Promise<void> {
        try {
            const stdoutJSON = JSON.parse(makefileOutput[2]);
            //contains URLs corresponding to files updated via our push to S3
            const updatedURLsArray = stdoutJSON.urls;
            // purgeCache purges the now stale content and requests the URLs to warm the cache for our users
            this.logger.save(this.currJob._id, `${JSON.stringify(updatedURLsArray)}`);
            if (this.config.get("shouldPurgeAll")) {
                await this.cdnConnector.purgeAll(this.currJob._id);
            } else {
                await this.cdnConnector.purge(this.currJob._id, updatedURLsArray);
                await this.jobRepository.insertPurgedUrls(this.currJob._id, updatedURLsArray);
            }

        } catch (error) {
            this.logger.error(this.currJob._id, error);
        }
    }

    async deploy(): Promise<CommandExecutorResponse> {
        this.throwIfItIsNotPublishable();
        let resp = await this.deployGeneric();
        try {
            const makefileOutput = resp.output.replace(/\r/g, '').split(/\n/);
            await this.purgePublishedContent(makefileOutput);
            this.logger.save(this.currJob._id, `${'(prod)'.padEnd(15)}Finished pushing to production`);
            this.logger.save(this.currJob._id, `${'(prod)'.padEnd(15)}Deploy details:\n\n${resp.output}`);
            return resp;
        } catch (errResult) {
            this.logger.save(this.currJob._id, `${'(prod)'.padEnd(15)}stdErr: ${errResult.stderr}`);
            throw errResult;
        }
    }
}