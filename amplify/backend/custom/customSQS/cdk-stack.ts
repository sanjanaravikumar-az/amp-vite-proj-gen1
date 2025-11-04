import * as cdk from 'aws-cdk-lib';
import * as AmplifyHelpers from '@aws-amplify/cli-extensibility-helper';
import { AmplifyDependentResourcesAttributes } from '../../types/amplify-dependent-resources-ref';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as iam from 'aws-cdk-lib/aws-iam';

export class cdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps, amplifyResourceProps?: AmplifyHelpers.AmplifyResourceProps) {
    super(scope, id, props);

    new cdk.CfnParameter(this, 'env', {
      type: 'String',
      description: 'Current Amplify CLI env name',
    });

    const amplifyProjectInfo = AmplifyHelpers.getProjectInfo();

    // Dead Letter Queue
    const deadLetterQueue = new sqs.Queue(this, 'DeadLetterQueue', {
      queueName: `dlq-${amplifyProjectInfo.projectName}-${cdk.Fn.ref('env')}`,
      retentionPeriod: cdk.Duration.days(14)
    });

    // Main SQS Queue
    const queue = new sqs.Queue(this, 'Queue', {
      queueName: `queue-${amplifyProjectInfo.projectName}-${cdk.Fn.ref('env')}`,
      visibilityTimeout: cdk.Duration.seconds(30),
      retentionPeriod: cdk.Duration.days(14),
      deadLetterQueue: {
        queue: deadLetterQueue,
        maxReceiveCount: 3
      }
    });

    // Sender Lambda
    const sender = new lambda.Function(this, 'Sender', {
      functionName: `sqs-sender-${amplifyProjectInfo.projectName}-${cdk.Fn.ref('env')}`,
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(30),
      code: lambda.Code.fromInline(`
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const sqs = new SQSClient({});

exports.handler = async (event) => {
  const { message, queueUrl } = event;
  try {
    const command = new SendMessageCommand({
      QueueUrl: queueUrl || process.env.SQS_QUEUE_URL,
      MessageBody: JSON.stringify(message),
    });
    const result = await sqs.send(command);
    return {
      statusCode: 200,
      body: JSON.stringify({
        messageId: result.MessageId,
        message: 'Message sent successfully'
      }),
    };
  } catch (error) {
    console.error('Error sending message:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to send message' }),
    };
  }
};
      `),
      environment: {
        SQS_QUEUE_URL: queue.queueUrl
      }
    });

    // Processor Lambda with explicit execution role
    const processorRole = new iam.Role(this, 'ProcessorRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
      ],
      inlinePolicies: {
        SQSPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'sqs:ReceiveMessage',
                'sqs:DeleteMessage',
                'sqs:GetQueueAttributes'
              ],
              resources: [queue.queueArn]
            })
          ]
        })
      }
    });

    const processor = new lambda.Function(this, 'Processor', {
      functionName: `sqs-processor-${amplifyProjectInfo.projectName}-${cdk.Fn.ref('env')}`,
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(30),
      role: processorRole,
      code: lambda.Code.fromInline(`
exports.handler = async (event) => {
  for (const record of event.Records) {
    try {
      const message = JSON.parse(record.body);
      console.log('Processing message:', message);
      // Add your message processing logic here
    } catch (error) {
      console.error('Error processing message:', error);
      throw error;
    }
  }
  return {
    statusCode: 200,
    body: 'Messages processed successfully'
  };
};
      `)
    });

    // Grant permissions
    queue.grantSendMessages(sender);

    // Add SQS as event source for processor
    processor.addEventSource(
      new lambdaEventSources.SqsEventSource(queue, {
        batchSize: 10
      })
    );

    // Outputs
    new cdk.CfnOutput(this, 'queueUrl', {
      value: queue.queueUrl,
      description: 'SQS Queue URL'
    });

    new cdk.CfnOutput(this, 'queueArn', {
      value: queue.queueArn,
      description: 'SQS Queue ARN'
    });

    new cdk.CfnOutput(this, 'senderFunctionName', {
      value: sender.functionName,
      description: 'SQS Sender Lambda function name'
    });

    new cdk.CfnOutput(this, 'processorFunctionName', {
      value: processor.functionName,
      description: 'SQS Processor Lambda function name'
    });
  }
}
