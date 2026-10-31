# AWS Lambda Web Adapter (vendored)

`lambda-adapter` is the x86_64 binary of [AWS Lambda Web Adapter](https://github.com/awslabs/aws-lambda-web-adapter)
**v1.1.0**, copied out of `public.ecr.aws/awsguru/aws-lambda-adapter:1.1.0`. Licensed Apache-2.0 (see `LICENSE`).

It is kept in the repo because pulling it from public ECR during `docker build` fails at random on GitHub-hosted
runners: they share IPs, and public ECR answers anonymous pulls with `429 Too Many Requests: Data limit exceeded`.
The project publishes no release binaries to download instead.

sha256: `358b36689e564ba479aba244916ba5226e18d7d01f4bf6bf164088552a71c40d`

To update, with Docker running:

```bash
docker pull --platform linux/amd64 public.ecr.aws/awsguru/aws-lambda-adapter:<version>
id=$(docker create --platform linux/amd64 public.ecr.aws/awsguru/aws-lambda-adapter:<version> /lambda-adapter)
docker cp "$id:/lambda-adapter" vendor/aws-lambda-adapter/lambda-adapter && docker rm "$id"
sha256sum vendor/aws-lambda-adapter/lambda-adapter   # record it above
```
